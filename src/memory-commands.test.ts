import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeMemoryCommand, MAX_MEMORY_QUERY_LENGTH, type MemoryCommandActor } from "./memory-commands.js";
import { MemoryStore, type MemoryEntry } from "./memory-store.js";

async function tempProject(): Promise<{ root: string; name: string }> {
  return { root: await mkdtemp(path.join(tmpdir(), "devbot-memory-cmd-project-")), name: "demo" };
}

async function newStore(): Promise<MemoryStore> {
  return new MemoryStore(await mkdtemp(path.join(tmpdir(), "devbot-memory-cmd-central-")));
}

function actor(userId: string, options: { projectAllowed?: boolean; controller?: boolean; owner?: boolean } = {}): MemoryCommandActor {
  return {
    access: { userId, projectAllowed: options.projectAllowed ?? true, controller: options.controller ?? false },
    owner: options.owner ?? false
  };
}

const ownerActor = actor("owner", { controller: true, owner: true });
const controllerActor = actor("controller", { controller: true });
const requesterActor = actor("requester");
const viewerActor = actor("viewer");
const peerActor = actor("peer-bot");
const strangerActor = actor("stranger", { projectAllowed: false });

async function seed(store: MemoryStore, project: { root: string; name: string }): Promise<{ decision: MemoryEntry; workroomOutcome: MemoryEntry }> {
  const decision = await store.add(project, {
    kind: "decision",
    text: "Use the waterfall renderer for terrain.",
    source: "manual",
    author: "owner",
    actorId: "owner"
  });
  const workroomOutcome = await store.add(project, {
    kind: "outcome",
    text: "succeeded: private waterfall prototype in the workroom.",
    source: "task",
    taskId: "task-1",
    author: "requester",
    actorId: "requester",
    requesterId: "requester",
    accessScope: "workroom"
  });
  return { decision, workroomOutcome };
}

test("memory commands fail closed for a user without project access", async () => {
  const project = await tempProject();
  const store = await newStore();
  const { decision } = await seed(store, project);

  const refusal = `You are not allowed to use project \`${project.name}\` under its .devbot policy.`;
  assert.equal(await executeMemoryCommand(store, project, strangerActor, { subcommand: "list" }), refusal);
  assert.equal(await executeMemoryCommand(store, project, strangerActor, { subcommand: "search", query: "waterfall" }), refusal);
  assert.equal(await executeMemoryCommand(store, project, strangerActor, { subcommand: "promote", id: decision.id }), refusal);
  assert.equal(await executeMemoryCommand(store, project, strangerActor, { subcommand: "forget", id: decision.id }), refusal);
  assert.equal(await executeMemoryCommand(store, project, strangerActor, { subcommand: "purge", confirm: project.name }), refusal);
  assert.equal(await store.count(project), 2);
});

test("memory list and search hide workroom outcomes from non-requester viewers and peers", async () => {
  const project = await tempProject();
  const store = await newStore();
  const { decision, workroomOutcome } = await seed(store, project);

  for (const privileged of [ownerActor, controllerActor, requesterActor]) {
    const listed = await executeMemoryCommand(store, project, privileged, { subcommand: "list" });
    assert.ok(listed.includes(decision.id), `${privileged.access.userId} should see the shared decision`);
    assert.ok(listed.includes(workroomOutcome.id), `${privileged.access.userId} should see the workroom outcome`);
  }

  for (const restricted of [viewerActor, peerActor]) {
    const listed = await executeMemoryCommand(store, project, restricted, { subcommand: "list" });
    assert.ok(listed.includes(decision.id), `${restricted.access.userId} should see the shared decision`);
    assert.ok(!listed.includes(workroomOutcome.id), `${restricted.access.userId} must not see the workroom outcome`);
    assert.ok(!listed.includes("prototype"), `${restricted.access.userId} must not see workroom outcome text`);

    const searched = await executeMemoryCommand(store, project, restricted, { subcommand: "search", query: "waterfall prototype workroom" });
    assert.ok(!searched.includes(workroomOutcome.id), `${restricted.access.userId} must not recover the workroom outcome via search`);
  }
});

test("memory promote requires a controller and makes an outcome recallable", async () => {
  const project = await tempProject();
  const store = await newStore();
  const { workroomOutcome } = await seed(store, project);

  const denied = await executeMemoryCommand(store, project, requesterActor, { subcommand: "promote", id: workroomOutcome.id });
  assert.equal(denied, "Only the owner or an approved controller can promote memory entries.");

  const missing = await executeMemoryCommand(store, project, controllerActor, { subcommand: "promote", id: "mem-does-not-exist" });
  assert.ok(missing.includes("No memory entry"));

  assert.equal((await store.recallFor(project, "waterfall prototype workroom", controllerActor.access)).length, 0);
  const promoted = await executeMemoryCommand(store, project, controllerActor, { subcommand: "promote", id: workroomOutcome.id });
  assert.ok(promoted.includes("Promoted"));
  const recalled = await store.recallFor(project, "waterfall prototype workroom", controllerActor.access);
  assert.deepEqual(recalled.map((entry) => entry.id), [workroomOutcome.id]);
});

test("memory forget requires the owner", async () => {
  const project = await tempProject();
  const store = await newStore();
  const { decision } = await seed(store, project);

  const denied = await executeMemoryCommand(store, project, controllerActor, { subcommand: "forget", id: decision.id });
  assert.equal(denied, "Only the configured Devbot owner can forget memory entries.");
  assert.equal(await store.count(project), 2);

  const removed = await executeMemoryCommand(store, project, ownerActor, { subcommand: "forget", id: decision.id });
  assert.ok(removed.includes("Forgot memory entry"));
  assert.ok(removed.includes("does not alter git history"));
  assert.equal(await store.count(project), 1);
});

test("memory purge requires the owner and an exact project-name confirmation", async () => {
  const project = await tempProject();
  const store = await newStore();
  await seed(store, project);
  const file = await store.fileFor(project);

  const denied = await executeMemoryCommand(store, project, controllerActor, { subcommand: "purge", confirm: project.name });
  assert.equal(denied, "Only the configured Devbot owner can purge project memory.");

  const unconfirmed = await executeMemoryCommand(store, project, ownerActor, { subcommand: "purge" });
  assert.ok(unconfirmed.includes("Confirmation mismatch"));
  const mismatched = await executeMemoryCommand(store, project, ownerActor, { subcommand: "purge", confirm: "other-project" });
  assert.ok(mismatched.includes("Confirmation mismatch"));
  assert.ok(await stat(file));

  const purged = await executeMemoryCommand(store, project, ownerActor, { subcommand: "purge", confirm: project.name });
  assert.ok(purged.includes("Purged 2 memory entries"));
  assert.ok(purged.includes("backups are unaffected"));
  await assert.rejects(() => stat(file));
  assert.equal(await store.count(project), 0);
});

test("memory search bounds oversized queries instead of failing", async () => {
  const project = await tempProject();
  const store = await newStore();
  await seed(store, project);

  const longQuery = `waterfall ${"x".repeat(MAX_MEMORY_QUERY_LENGTH * 3)}`;
  const output = await executeMemoryCommand(store, project, ownerActor, { subcommand: "search", query: longQuery });
  assert.ok(!output.includes(longQuery));
  assert.ok(output.includes(longQuery.slice(0, MAX_MEMORY_QUERY_LENGTH)));
});
