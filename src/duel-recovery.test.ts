import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CollabStore } from "./collab-store.js";
import { DuelStore } from "./duel-store.js";
import { reconcileInterruptedDuels } from "./duel-recovery.js";

async function newStores(maxConversations = 200): Promise<{ duelStore: DuelStore; collabStore: CollabStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "devbot-duel-recovery-"));
  return {
    duelStore: new DuelStore(path.join(dir, "duels.json")),
    collabStore: new CollabStore(path.join(dir, "collab.json"), maxConversations)
  };
}

async function startDuel(duelStore: DuelStore, collabStore: CollabStore, taskId: string): Promise<string> {
  const conversation = await collabStore.start({ intent: "duel", title: `Duel: ${taskId}`, requester: "tester" });
  await duelStore.start({ id: conversation.id, taskId, projectName: "webapp" });
  return conversation.id;
}

test("startup recovery fails interrupted duels and closes their collaboration conversations", async () => {
  const { duelStore, collabStore } = await newStores();
  const interruptedId = await startDuel(duelStore, collabStore, "task-1");

  const result = await reconcileInterruptedDuels(duelStore, collabStore);

  assert.deepEqual(result.interruptedIds, [interruptedId]);
  assert.deepEqual(result.closedIds, [interruptedId]);
  assert.equal((await duelStore.get(interruptedId))?.status, "failed");
  assert.equal((await collabStore.get(interruptedId))?.status, "closed");
});

test("startup recovery frees the collaboration slot a crash-interrupted duel was holding", async () => {
  const { duelStore, collabStore } = await newStores(1);
  await startDuel(duelStore, collabStore, "task-1");

  // The single open slot is consumed, so a fresh conversation cannot start yet.
  await assert.rejects(
    collabStore.start({ intent: "duel", title: "Duel: task-2", requester: "tester" }),
    /collaboration limit/i
  );

  await reconcileInterruptedDuels(duelStore, collabStore);

  // After recovery the interrupted duel's conversation is closed, so the slot is available again.
  const reopened = await collabStore.start({ intent: "duel", title: "Duel: task-2", requester: "tester" });
  assert.equal(reopened.status, "open");
});

test("startup recovery is idempotent: a second pass closes nothing and never throws", async () => {
  const { duelStore, collabStore } = await newStores();
  const interruptedId = await startDuel(duelStore, collabStore, "task-1");

  const first = await reconcileInterruptedDuels(duelStore, collabStore);
  assert.deepEqual(first.closedIds, [interruptedId]);

  const second = await reconcileInterruptedDuels(duelStore, collabStore);
  assert.deepEqual(second.interruptedIds, []);
  assert.deepEqual(second.closedIds, []);
  assert.equal((await collabStore.get(interruptedId))?.status, "closed");
});

test("startup recovery leaves completed duels and their conversations untouched", async () => {
  const { duelStore, collabStore } = await newStores();
  const doneId = await startDuel(duelStore, collabStore, "task-1");
  await duelStore.succeed(doneId, {
    authorTier: "standard",
    reviewerTier: "deep",
    reviewerIndependence: "independent",
    evidence: { patchHash: "hash", fileCount: 0, includedFileCount: 0, omittedFileCount: 0, truncated: false },
    overall: "approve",
    issues: []
  });

  const result = await reconcileInterruptedDuels(duelStore, collabStore);

  assert.deepEqual(result.interruptedIds, []);
  assert.equal((await duelStore.get(doneId))?.status, "succeeded");
  assert.equal((await collabStore.get(doneId))?.status, "open");
});

test("startup recovery reports a close failure without aborting the rest of the batch", async () => {
  const { duelStore } = await newStores();
  const interruptedId = "collab-stub-1";
  await duelStore.start({ id: interruptedId, taskId: "task-1", projectName: "webapp" });

  const errors: string[] = [];
  const failingCollabStore = {
    close: async (id: string): Promise<never> => {
      throw new Error(`close failed for ${id}`);
    }
  };

  const result = await reconcileInterruptedDuels(duelStore, failingCollabStore, (id) => errors.push(id));

  assert.ok(result.interruptedIds.includes(interruptedId));
  assert.deepEqual(result.closedIds, []);
  assert.ok(errors.includes(interruptedId));
  assert.equal((await duelStore.get(interruptedId))?.status, "failed");
});
