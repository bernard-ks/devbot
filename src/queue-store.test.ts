import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatQueueDigest,
  formatQueueList,
  nextQueuedItem,
  pendingQueueCount,
  QueueStore,
  retainQueueItems,
  type QueueItem
} from "./queue-store.js";

async function tempStore(maxRecords?: number): Promise<QueueStore> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-queue-store-"));
  return new QueueStore(path.join(root, "queue.json"), maxRecords);
}

test("queue add/list preserves insertion order and position", async () => {
  const store = await tempStore();
  await store.add({ project: "web", taskText: "first", mode: "action", addedBy: "tom" });
  await store.add({ project: "web", taskText: "second", mode: "answer", addedBy: "tom" });
  const items = await store.list();
  assert.equal(items.length, 2);
  assert.equal(items[0]?.taskText, "first");
  assert.equal(items[1]?.taskText, "second");
  assert.equal(items[0]?.state, "queued");
});

test("queue survives reload from disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-queue-reload-"));
  const filePath = path.join(root, "queue.json");
  const store = new QueueStore(filePath);
  await store.add({ project: "web", taskText: "first", mode: "action", addedBy: "tom" });

  const reloaded = new QueueStore(filePath);
  const items = await reloaded.list();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.taskText, "first");
});

test("removeAtPosition marks a queued item as skipped without deleting history", async () => {
  const store = await tempStore();
  await store.add({ project: "web", taskText: "first", mode: "action", addedBy: "tom" });
  await store.add({ project: "web", taskText: "second", mode: "action", addedBy: "tom" });
  const removed = await store.removeAtPosition(1);
  assert.equal(removed?.state, "skipped");
  const items = await store.list();
  assert.equal(items.length, 2);
  assert.equal(items[0]?.state, "skipped");
  assert.equal(items[1]?.state, "queued");
});

test("removeAtPosition rejects the currently running item", async () => {
  const store = await tempStore();
  const item = await store.add({ project: "web", taskText: "first", mode: "action", addedBy: "tom" });
  await store.markRunning(item.id, "task-1");
  await assert.rejects(() => store.removeAtPosition(1), /cannot be removed/);
});

test("clear marks all queued items as skipped and leaves running/done alone", async () => {
  const store = await tempStore();
  const running = await store.add({ project: "web", taskText: "running", mode: "action", addedBy: "tom" });
  await store.markRunning(running.id, "task-1");
  await store.add({ project: "web", taskText: "queued-1", mode: "action", addedBy: "tom" });
  await store.add({ project: "web", taskText: "queued-2", mode: "action", addedBy: "tom" });
  const cleared = await store.clear();
  assert.equal(cleared, 2);
  const items = await store.list();
  assert.equal(items.find((entry) => entry.taskText === "running")?.state, "running");
  assert.equal(items.filter((entry) => entry.state === "skipped").length, 2);
});

test("markRunning then markFinished transitions state and records summary", async () => {
  const store = await tempStore();
  const item = await store.add({ project: "web", taskText: "first", mode: "action", addedBy: "tom" });
  await store.markRunning(item.id, "task-42");
  let current = await store.get(item.id);
  assert.equal(current?.state, "running");
  assert.equal(current?.taskId, "task-42");

  await store.markFinished(item.id, { state: "done", summary: "Shipped the change." });
  current = await store.get(item.id);
  assert.equal(current?.state, "done");
  assert.equal(current?.summary, "Shipped the change.");
  assert.ok(current?.finishedAt);
});

test("runner state start/stop and pending digest persist", async () => {
  const store = await tempStore();
  let runner = await store.getRunner();
  assert.equal(runner.running, false);

  runner = await store.startRunner("tom", true);
  assert.equal(runner.running, true);
  assert.equal(runner.stopOnFailure, true);
  assert.equal(runner.startedBy, "tom");

  runner = await store.stopRunner();
  assert.equal(runner.running, false);

  await store.setPendingDigest(true);
  runner = await store.getRunner();
  assert.equal(runner.pendingDigest, true);
});

test("recoverInterrupted fails running items and returns them", async () => {
  const store = await tempStore();
  const item = await store.add({ project: "web", taskText: "first", mode: "action", addedBy: "tom" });
  await store.markRunning(item.id, "task-1");
  const recovered = await store.recoverInterrupted("Interrupted when Devbot restarted.");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.state, "failed");
  const current = await store.get(item.id);
  assert.equal(current?.state, "failed");
  assert.equal(current?.summary, "Interrupted when Devbot restarted.");
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

test("formatQueueList renders a numbered list with state and truncated task text", () => {
  const items: QueueItem[] = [item("a", "queued"), item("b", "done")];
  const text = formatQueueList(items);
  assert.match(text, /1\. \*\*queued\*\*/);
  assert.match(text, /2\. \*\*done\*\*/);
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

function item(id: string, state: QueueItem["state"]): QueueItem {
  return {
    id,
    project: "web",
    taskText: `task ${id}`,
    mode: "action",
    state,
    addedBy: "tom",
    addedAt: new Date(0).toISOString()
  };
}
