import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { splitDiscordMessage } from "./messages.js";
import {
  checkMemoryStoreHealth,
  formatMemoryList,
  MemoryStore,
  type MemoryAccessContext,
  type MemoryEntry
} from "./memory-store.js";
import { TaskStore } from "./task-store.js";

async function tempProject(): Promise<{ root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-memory-project-"));
  return { root };
}

async function tempStoreRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "devbot-memory-central-"));
}

const owner: MemoryAccessContext = { userId: "owner", projectAllowed: true, controller: true };
const controller: MemoryAccessContext = { userId: "controller", projectAllowed: true, controller: true };
const requester: MemoryAccessContext = { userId: "requester", projectAllowed: true, controller: false };
const otherViewer: MemoryAccessContext = { userId: "other-viewer", projectAllowed: true, controller: false };
const unauthorized: MemoryAccessContext = { userId: "stranger", projectAllowed: false, controller: false };
/** A peer Devbot acting on behalf of another project is modeled the same as any non-controller project viewer. */
const peer: MemoryAccessContext = { userId: "peer-bot", projectAllowed: true, controller: false };

test("memory store persists entries under a central Devbot-owned store, not the managed project checkout", async () => {
  const project = await tempProject();
  const storeRoot = await tempStoreRoot();
  const store = new MemoryStore(storeRoot);

  await store.add(project, { kind: "note", text: "Central store note.", source: "manual", author: "tom" });

  const file = await store.fileFor(project);
  assert.ok(file.startsWith(storeRoot), "memory file must live under the configured central store root");
  assert.ok(await readFile(file, "utf8"));

  const projectDevbotFile = path.join(project.root, ".devbot", "memory.jsonl");
  await assert.rejects(() => stat(projectDevbotFile));
});

test("memory store file and directory use owner-only permissions", { skip: process.platform === "win32" }, async () => {
  const project = await tempProject();
  const storeRoot = await tempStoreRoot();
  const store = new MemoryStore(storeRoot);
  await store.add(project, { kind: "note", text: "Permission check.", source: "manual", author: "tom" });

  const file = await store.fileFor(project);
  const fileStats = await stat(file);
  const dirStats = await stat(path.dirname(file));
  assert.equal(fileStats.mode & 0o777, 0o600);
  assert.equal(dirStats.mode & 0o777, 0o700);
});

test("memory store round-trips decisions, notes, and outcomes with correct default trust/status", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());

  const decision = await store.add(project, {
    kind: "decision",
    text: "Move the worker to Vite.",
    source: "manual",
    author: "tom",
    actorId: "tom-id"
  });
  assert.equal(decision.status, "active");
  assert.equal(decision.trust, "trusted");
  assert.equal(decision.accessScope, "project");

  const outcome = await store.add(project, {
    kind: "outcome",
    text: "succeeded: migrate build tooling | Files: vite.config.ts",
    source: "task",
    taskId: "task-1",
    author: "tom",
    tags: ["succeeded"]
  });
  assert.equal(outcome.status, "proposed");
  assert.equal(outcome.trust, "untrusted");

  const entries = await store.list(project, { access: owner });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.kind, "outcome");
  assert.equal(entries[1]?.id, decision.id);
  assert.equal(await store.count(project), 2);

  const decisionsOnly = await store.list(project, { access: owner, kind: "decision" });
  assert.equal(decisionsOnly.length, 1);
  assert.equal(decisionsOnly[0]?.id, decision.id);
});

test("memory store prunes only the oldest outcome entries beyond the outcome cap", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot(), 3);

  await store.add(project, { kind: "decision", text: "Keep decisions forever.", source: "manual", author: "tom" });
  for (let index = 0; index < 5; index += 1) {
    await store.add(project, {
      kind: "outcome",
      text: `outcome ${index}`,
      source: "task",
      taskId: `task-${index}`,
      author: "tom"
    });
  }

  const entries = await store.list(project, { access: owner, limit: 100 });
  const outcomes = entries.filter((entry) => entry.kind === "outcome");
  const decisions = entries.filter((entry) => entry.kind === "decision");
  assert.equal(outcomes.length, 3);
  assert.equal(decisions.length, 1);
  assert.deepEqual(
    outcomes.map((entry) => entry.text).sort(),
    ["outcome 2", "outcome 3", "outcome 4"].sort()
  );
});

test("memory store prunes toward a total entry cap, dropping proposed/untrusted entries first", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot(), 500, 3);

  const decision = await store.add(project, { kind: "decision", text: "Trusted decision to keep.", source: "manual", author: "tom" });
  for (let index = 0; index < 4; index += 1) {
    await store.add(project, { kind: "outcome", text: `outcome ${index}`, source: "task", taskId: `task-${index}`, author: "tom" });
  }

  const entries = await store.list(project, { access: owner, limit: 100 });
  assert.equal(entries.length, 3);
  assert.ok(entries.some((entry) => entry.id === decision.id), "the trusted decision must survive total-cap pruning");
});

test("memory store refuses to grow the file past its configured byte budget", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot(), 500, 2_000, 300);

  await store.add(project, { kind: "note", text: "First short note.", source: "manual", author: "tom" });
  await assert.rejects(
    () => store.add(project, { kind: "note", text: "x".repeat(200), source: "manual", author: "tom" }),
    /byte limit/
  );
});

test("memory store rejects empty or oversized text", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  await assert.rejects(() => store.add(project, { kind: "note", text: "   ", source: "manual", author: "tom" }));
  await assert.rejects(() => store.add(project, { kind: "note", text: "x".repeat(5_000), source: "manual", author: "tom" }));
});

test("memory store redacts secrets in stored text, tags, and author at write time", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const entry = await store.add(project, {
    kind: "note",
    text: "Rotated key sk-abcdefghijklmnopqrstuvwx after the incident.",
    source: "manual",
    author: "tom",
    tags: ["token=sk-abcdefghijklmnopqrstuvwx"]
  });
  assert.doesNotMatch(entry.text, /sk-abcdefghijklmnopqrstuvwx/);
  assert.match(entry.text, /\[REDACTED API KEY\]/);
  assert.ok(entry.tags.every((tag) => !tag.includes("sk-abcdefghijklmnopqrstuvwx")));
});

test("memory store redacts secrets in legacy entries lazily on read", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const file = await store.fileFor(project);
  await mkdir(path.dirname(file), { recursive: true });
  const legacyEntry = {
    id: "mem-legacy1-aaa",
    kind: "note",
    text: "Leaked AWS key AKIAABCDEFGHIJKLMNOP in old note.",
    source: "manual",
    author: "tom",
    createdAt: new Date().toISOString(),
    tags: [],
    accessScope: "project"
  };
  await writeFile(file, `${JSON.stringify(legacyEntry)}\n`, "utf8");

  const entries = await store.list(project, { access: owner });
  assert.equal(entries.length, 1);
  assert.doesNotMatch(entries[0]?.text ?? "", /AKIAABCDEFGHIJKLMNOP/);
  assert.match(entries[0]?.text ?? "", /\[REDACTED AWS KEY\]/);
});

test("memory store forgets a specific entry, and forgetting does not remove other entries", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const entry = await store.add(project, { kind: "note", text: "Note to self.", source: "manual", author: "tom" });
  const other = await store.add(project, { kind: "note", text: "Keep me.", source: "manual", author: "tom" });

  assert.equal(await store.forget(project, "mem-does-not-exist"), false);
  assert.equal(await store.forget(project, entry.id), true);
  const remaining = await store.list(project, { access: owner });
  assert.deepEqual(remaining.map((item) => item.id), [other.id]);
  assert.equal(await store.forget(project, entry.id), false);
});

test("memory store get looks up a single entry by id and honors access scoping", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const privateOutcome = await store.add(project, {
    kind: "outcome",
    text: "succeeded: private task result.",
    source: "task",
    taskId: "task-1",
    author: "tom",
    accessScope: "workroom",
    requesterId: "requester"
  });

  assert.equal((await store.get(project, privateOutcome.id, requester))?.id, privateOutcome.id);
  assert.equal((await store.get(project, privateOutcome.id, otherViewer)), undefined);
  assert.equal((await store.get(project, "mem-missing", owner)), undefined);
});

test("memory store purgeProject deletes the project's file entirely", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  await store.add(project, { kind: "note", text: "About to be purged.", source: "manual", author: "tom" });
  await store.purgeProject(project);
  assert.equal(await store.count(project), 0);
});

test("memory store promote flips a proposed/untrusted outcome to active/trusted", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const outcome = await store.add(project, {
    kind: "outcome",
    text: "succeeded: refactor the router.",
    source: "task",
    taskId: "task-9",
    author: "tom"
  });
  assert.equal(outcome.status, "proposed");

  const promoted = await store.promote(project, outcome.id);
  assert.equal(promoted?.status, "active");
  assert.equal(promoted?.trust, "trusted");
  assert.equal(await store.promote(project, "mem-missing"), undefined);
});

test("memory store serializes concurrent writes without losing entries", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());

  await Promise.all(
    Array.from({ length: 15 }, (_, index) =>
      store.add(project, { kind: "note", text: `concurrent note ${index}`, source: "manual", author: "tom" })
    )
  );

  assert.equal(await store.count(project), 15);
});

test("memory store search ranks by relevance to a query and applies access control", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  await store.add(project, { kind: "decision", text: "We moved the worker build to Vite in June.", source: "manual", author: "tom" });
  await store.add(project, { kind: "note", text: "Unrelated note about the changelog.", source: "manual", author: "tom" });
  await store.add(project, {
    kind: "outcome",
    text: "succeeded: rebuilt the worker with Vite tooling.",
    source: "task",
    taskId: "task-private",
    author: "tom",
    accessScope: "workroom",
    requesterId: "requester"
  });

  const ownerResults = await store.search(project, "vite worker build", owner);
  assert.ok(ownerResults.length >= 2, "owner should see both the decision and the private outcome");

  const strangerResults = await store.search(project, "vite worker build", unauthorized);
  assert.equal(strangerResults.length, 0);

  const otherViewerResults = await store.search(project, "vite worker build", otherViewer);
  assert.ok(otherViewerResults.every((entry) => entry.accessScope !== "workroom"));
});

test("memory access: workroom-scoped and internal entries are limited to their requester and controllers", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const privateOutcome = await store.add(project, {
    kind: "outcome",
    text: "succeeded: rotated the private staging credentials.",
    source: "task",
    taskId: "task-private",
    author: "tom",
    accessScope: "workroom",
    requesterId: "requester",
    internal: true
  });
  const publicDecision = await store.add(project, {
    kind: "decision",
    text: "Adopt Vite for the build pipeline.",
    source: "manual",
    author: "tom"
  });

  const asRequester = await store.list(project, { access: requester });
  assert.ok(asRequester.some((entry) => entry.id === privateOutcome.id));
  assert.ok(asRequester.some((entry) => entry.id === publicDecision.id));

  const asController = await store.list(project, { access: controller });
  assert.ok(asController.some((entry) => entry.id === privateOutcome.id));

  const asOtherViewer = await store.list(project, { access: otherViewer });
  assert.ok(!asOtherViewer.some((entry) => entry.id === privateOutcome.id), "an unrelated project viewer must not see workroom-private memory");
  assert.ok(asOtherViewer.some((entry) => entry.id === publicDecision.id));

  const asPeer = await store.list(project, { access: peer });
  assert.ok(!asPeer.some((entry) => entry.id === privateOutcome.id), "a peer bot must not recover private workroom memory either");

  const asUnauthorized = await store.list(project, { access: unauthorized });
  assert.equal(asUnauthorized.length, 0, "a viewer without project access sees nothing at all");
});

test("memory recallFor only returns access-permitted, active, trusted entries", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const query = "storage layer details";
  const privateOutcome = await store.add(project, {
    kind: "outcome",
    text: "succeeded: migrated the storage layer to sqlite.",
    source: "task",
    taskId: "task-1",
    author: "tom",
    accessScope: "workroom",
    requesterId: "requester"
  });
  await store.add(project, {
    kind: "decision",
    text: "Chose sqlite storage for local-first simplicity.",
    source: "manual",
    author: "tom"
  });

  const beforePromotion = await store.recallFor(project, query, owner);
  assert.ok(!beforePromotion.some((entry) => entry.id === privateOutcome.id), "unpromoted automatic outcomes must not be recallable");

  await store.promote(project, privateOutcome.id);
  const asOwnerAfterPromotion = await store.recallFor(project, query, owner);
  assert.ok(asOwnerAfterPromotion.some((entry) => entry.id === privateOutcome.id));

  const asOtherViewer = await store.recallFor(project, query, otherViewer);
  assert.ok(!asOtherViewer.some((entry) => entry.id === privateOutcome.id), "recall must still respect workroom scoping even after promotion");
});

test("memory store health check reports readable/writable/quarantined status and never touches the project checkout", async () => {
  const project = await tempProject();
  const storeRoot = await tempStoreRoot();
  const missing = await checkMemoryStoreHealth(project, storeRoot);
  assert.equal(missing.readable, true);
  assert.equal(missing.writable, true);
  assert.equal(missing.quarantinedCount, 0);

  const store = new MemoryStore(storeRoot);
  await store.add(project, { kind: "note", text: "Health check note.", source: "manual", author: "tom" });
  const populated = await checkMemoryStoreHealth(project, storeRoot);
  assert.equal(populated.readable, true);
  assert.equal(populated.writable, true);

  const projectDevbotDir = path.join(project.root, ".devbot");
  await assert.rejects(() => stat(projectDevbotDir), "doctor's memory health probe must not create anything inside the project checkout");
});

test("memory store quarantines corrupt or invalid lines instead of destroying them on the next write", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const file = await store.fileFor(project);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "not valid json\n{\"id\":\"bad\"}\n", "utf8");

  const health = await checkMemoryStoreHealth(project, store.root);
  assert.equal(health.quarantinedCount, 2);

  await store.add(project, { kind: "note", text: "New note after corruption.", source: "manual", author: "tom" });
  const raw = await readFile(file, "utf8");
  assert.match(raw, /not valid json/, "quarantined raw lines must survive a subsequent mutation");
  assert.match(raw, /"bad"/);

  const entries = await store.list(project, { access: owner });
  assert.equal(entries.length, 1);
});

test("memory store treats a valid entry missing tags as an empty tag list instead of crashing", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const file = await store.fileFor(project);
  await mkdir(path.dirname(file), { recursive: true });
  const withoutTags = {
    id: "mem-notags-abc",
    kind: "decision",
    text: "Entry recorded before tags existed.",
    source: "manual",
    author: "tom",
    createdAt: new Date().toISOString(),
    accessScope: "project"
  };
  await writeFile(file, `${JSON.stringify(withoutTags)}\n`, "utf8");

  const entries = await store.list(project, { access: owner });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.tags, []);
  assert.doesNotThrow(() => formatMemoryList(entries, "demo"));
});

test("memory store quarantines entries with an unsupported schema version", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const file = await store.fileFor(project);
  await mkdir(path.dirname(file), { recursive: true });
  const futureVersion = {
    schemaVersion: 99,
    id: "mem-future-abc",
    kind: "note",
    text: "From a future schema.",
    source: "manual",
    author: "tom",
    createdAt: new Date().toISOString(),
    tags: []
  };
  await writeFile(file, `${JSON.stringify(futureVersion)}\n`, "utf8");

  const entries = await store.list(project, { access: owner });
  assert.equal(entries.length, 0);
  const health = await checkMemoryStoreHealth(project, store.root);
  assert.equal(health.quarantinedCount, 1);
});

test("memory store quarantines entries with wrong-typed or malformed fields", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const file = await store.fileFor(project);
  await mkdir(path.dirname(file), { recursive: true });
  const lines = [
    { id: "not-a-valid-id-format", kind: "note", text: "bad id", source: "manual", author: "tom", createdAt: new Date().toISOString(), tags: [] },
    { id: "mem-ok-aaa", kind: "not-a-kind", text: "bad kind", source: "manual", author: "tom", createdAt: new Date().toISOString(), tags: [] },
    { id: "mem-ok-bbb", kind: "note", text: 12345, source: "manual", author: "tom", createdAt: new Date().toISOString(), tags: [] }
  ];
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  const entries = await store.list(project, { access: owner });
  assert.equal(entries.length, 0);
  const health = await checkMemoryStoreHealth(project, store.root);
  assert.equal(health.quarantinedCount, 3);
});

test("memory store refuses to read or write through a symlink planted at the store file path", { skip: process.platform === "win32" }, async () => {
  const project = await tempProject();
  const storeRoot = await tempStoreRoot();
  const store = new MemoryStore(storeRoot);
  const file = await store.fileFor(project);
  await mkdir(path.dirname(file), { recursive: true });
  const decoyTarget = path.join(storeRoot, "decoy-target.txt");
  await writeFile(decoyTarget, "outside data\n", "utf8");
  await symlink(decoyTarget, file);

  await assert.rejects(() => store.list(project, { access: owner }), /symlink/);
  await assert.rejects(() => store.add(project, { kind: "note", text: "should not follow symlink", source: "manual", author: "tom" }), /symlink/);

  const decoyStats = await lstat(decoyTarget);
  assert.ok(decoyStats.isFile());
});

test("formatMemoryList reports empty state and renders entry summaries with status annotations", () => {
  assert.match(formatMemoryList([], "webapp"), /No memory entries recorded yet for `webapp`/);
  assert.match(formatMemoryList([], "webapp", "vite"), /No memory entries for `webapp` match "vite"/);

  const entries: MemoryEntry[] = [
    {
      schemaVersion: 1,
      id: "mem-1",
      kind: "decision",
      text: "Chose SQLite for local storage.",
      source: "manual",
      author: "tom",
      createdAt: "2026-01-01T00:00:00.000Z",
      tags: ["storage"],
      accessScope: "project",
      status: "active",
      trust: "trusted"
    },
    {
      schemaVersion: 1,
      id: "mem-2",
      kind: "outcome",
      text: "succeeded: migrate build.",
      source: "task",
      author: "tom",
      createdAt: "2026-01-02T00:00:00.000Z",
      tags: ["succeeded"],
      accessScope: "project",
      status: "proposed",
      trust: "untrusted"
    }
  ];
  const list = formatMemoryList(entries, "webapp");
  assert.match(list, /mem-1/);
  assert.match(list, /decision\/manual/);
  assert.match(list, /\[storage\]/);
  assert.match(list, /\{proposed\}/);
});

test("formatMemoryList output for a maximal entry set is chunked to fit Discord's message limit", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  for (let index = 0; index < 25; index += 1) {
    await store.add(project, {
      kind: "note",
      text: `Note number ${index}: ${"detail ".repeat(20)}`,
      source: "manual",
      author: "tom"
    });
  }
  const entries = await store.list(project, { access: owner, limit: 25 });
  const rendered = formatMemoryList(entries, "webapp");
  const chunks = splitDiscordMessage(rendered);
  assert.ok(chunks.length > 1, "a maximal memory list must split into more than one Discord message");
  assert.ok(chunks.every((chunk) => chunk.length <= 2_000));
});

function legacyLine(id: string, text: string): string {
  return JSON.stringify({
    id,
    kind: "decision",
    text,
    source: "manual",
    author: "tom",
    createdAt: "2026-06-01T00:00:00.000Z",
    tags: ["legacy"],
    accessScope: "project"
  });
}

test("memory store migrates a legacy in-checkout memory file into the central store and retires it", async () => {
  const project = await tempProject();
  const legacyDirectory = path.join(project.root, ".devbot");
  const legacyFile = path.join(legacyDirectory, "memory.jsonl");
  await mkdir(legacyDirectory, { recursive: true });
  const corruptLine = '{"broken":';
  await writeFile(
    legacyFile,
    [legacyLine("mem-legacy-aaa", "Ship the v1 importer."), legacyLine("mem-legacy-bbb", "Token AKIAABCDEFGHIJKLMNOP leaked once."), corruptLine].join("\n") + "\n",
    "utf8"
  );

  const store = new MemoryStore(await tempStoreRoot());
  const entries = await store.list(project, { access: owner });
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ["mem-legacy-aaa", "mem-legacy-bbb"]);
  const migrated = entries.find((entry) => entry.id === "mem-legacy-bbb");
  assert.ok(migrated && !migrated.text.includes("AKIAABCDEFGHIJKLMNOP"), "secrets in legacy entries must be redacted");
  assert.ok(migrated?.text.includes("[REDACTED AWS KEY]"));

  assert.equal((await store.recallFor(project, "ship the importer", owner)).length, 0, "migrated entries stay untrusted until promoted");

  await assert.rejects(() => stat(legacyFile), "legacy file must be retired from the checkout");
  await assert.rejects(() => stat(legacyDirectory), "an emptied legacy .devbot directory is removed");

  const centralRaw = await readFile(await store.fileFor(project), "utf8");
  assert.ok(centralRaw.includes(corruptLine), "corrupt legacy lines are quarantined, not destroyed");
});

test("memory store legacy migration keeps a .devbot directory that still holds other files", async () => {
  const project = await tempProject();
  const legacyDirectory = path.join(project.root, ".devbot");
  await mkdir(legacyDirectory, { recursive: true });
  const policyFile = path.join(legacyDirectory, "project.json");
  await writeFile(policyFile, "{}\n", "utf8");
  await writeFile(path.join(legacyDirectory, "memory.jsonl"), legacyLine("mem-legacy-ccc", "Keep the policy file.") + "\n", "utf8");

  const store = new MemoryStore(await tempStoreRoot());
  const entries = await store.list(project, { access: owner });
  assert.deepEqual(entries.map((entry) => entry.id), ["mem-legacy-ccc"]);

  await assert.rejects(() => stat(path.join(legacyDirectory, "memory.jsonl")));
  assert.ok(await stat(policyFile), "unrelated .devbot files must survive migration");
});

test("memory store legacy migration refuses to follow a symlinked .devbot directory", { skip: process.platform === "win32" }, async () => {
  const project = await tempProject();
  const outside = await tempStoreRoot();
  await writeFile(path.join(outside, "memory.jsonl"), legacyLine("mem-legacy-ddd", "Planted via symlink.") + "\n", "utf8");
  await symlink(outside, path.join(project.root, ".devbot"));

  const store = new MemoryStore(await tempStoreRoot());
  const entries = await store.list(project, { access: owner });
  assert.equal(entries.length, 0);
  assert.ok(await stat(path.join(outside, "memory.jsonl")), "symlink targets must never be consumed or deleted");
});

test("memory store legacy migration leaves oversized legacy files in place", async () => {
  const project = await tempProject();
  const legacyDirectory = path.join(project.root, ".devbot");
  const legacyFile = path.join(legacyDirectory, "memory.jsonl");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(legacyFile, legacyLine("mem-legacy-eee", "x".repeat(1_000)) + "\n", "utf8");

  const store = new MemoryStore(await tempStoreRoot(), 500, 2_000, 512);
  const entries = await store.list(project, { access: owner });
  assert.equal(entries.length, 0);
  assert.ok(await stat(legacyFile), "an oversized legacy file is skipped, not deleted");
});

test("memory store quarantines a stored entry that lacks an explicit access scope instead of defaulting to project", async () => {
  const project = await tempProject();
  const store = new MemoryStore(await tempStoreRoot());
  const file = await store.fileFor(project);
  await mkdir(path.dirname(file), { recursive: true });
  const scopeless = {
    id: "mem-scopeless-aaa",
    kind: "outcome",
    text: "succeeded: touched a private workroom secret outcome.",
    source: "task",
    taskId: "task-unknown",
    author: "tom",
    createdAt: new Date().toISOString(),
    tags: []
  };
  await writeFile(file, `${JSON.stringify(scopeless)}\n`, "utf8");

  assert.equal(
    (await store.list(project, { access: owner })).length,
    0,
    "an entry with no explicit scope is never surfaced as project memory, even for the owner"
  );
  const health = await checkMemoryStoreHealth(project, store.root);
  assert.equal(health.quarantinedCount, 1);
});

test("legacy migration quarantines a scopeless private outcome when no authoritative task record can vouch for it", async () => {
  const project = await tempProject();
  const legacyDirectory = path.join(project.root, ".devbot");
  const legacyFile = path.join(legacyDirectory, "memory.jsonl");
  await mkdir(legacyDirectory, { recursive: true });
  const secret = {
    id: "mem-secret-aaa",
    kind: "outcome",
    text: "succeeded: private workroom secret outcome.",
    source: "task",
    taskId: "task-gone",
    author: "tom",
    createdAt: "2026-06-01T00:00:00.000Z",
    tags: []
  };
  await writeFile(legacyFile, `${JSON.stringify(secret)}\n`, "utf8");

  // No task lookup is wired, so the migrator cannot establish the record's scope and must fail closed.
  const store = new MemoryStore(await tempStoreRoot());
  for (const viewer of [owner, controller, requester, otherViewer, peer]) {
    const listed = await store.list(project, { access: viewer });
    assert.ok(!listed.some((entry) => entry.id === secret.id), "a scopeless private outcome must never surface after migration");
    const recalled = await store.recallFor(project, "private workroom secret outcome", viewer);
    assert.ok(!recalled.some((entry) => entry.id === secret.id), "a scopeless private outcome must never be recallable after migration");
  }
  const health = await checkMemoryStoreHealth(project, store.root);
  assert.equal(health.quarantinedCount, 1, "the unresolved private outcome is quarantined, not imported");
  await assert.rejects(() => stat(legacyFile), "the legacy file is still retired");
});

test("legacy migration recovers scope and requester from the authoritative task record and keeps a private outcome private", async () => {
  const project = await tempProject();
  const legacyDirectory = path.join(project.root, ".devbot");
  const legacyFile = path.join(legacyDirectory, "memory.jsonl");
  await mkdir(legacyDirectory, { recursive: true });
  const secret = {
    id: "mem-secret-bbb",
    kind: "outcome",
    text: "succeeded: private workroom secret outcome to recover.",
    source: "task",
    taskId: "task-secret",
    author: "tom",
    createdAt: "2026-06-01T00:00:00.000Z",
    tags: []
  };
  await writeFile(legacyFile, `${JSON.stringify(secret)}\n`, "utf8");

  const taskStateFile = path.join(await tempStoreRoot(), "tasks.json");
  await writeFile(
    taskStateFile,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "task-secret",
          status: "succeeded",
          source: "discord",
          mode: "action",
          projectName: "demo",
          requester: "tom",
          text: "rotate the private staging credentials",
          includePatterns: [],
          accessScope: "workroom",
          requesterId: "requester",
          startedAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z"
        }
      ]
    }),
    "utf8"
  );
  const taskStore = new TaskStore(taskStateFile);
  const store = new MemoryStore(await tempStoreRoot(), undefined, undefined, undefined, taskStore);

  const asOtherViewer = await store.list(project, { access: otherViewer });
  assert.ok(!asOtherViewer.some((entry) => entry.id === secret.id), "an unrelated project viewer must not list a recovered private outcome");
  const asPeer = await store.list(project, { access: peer });
  assert.ok(!asPeer.some((entry) => entry.id === secret.id), "a peer bot must not list a recovered private outcome");

  const asRequester = await store.list(project, { access: requester });
  const recovered = asRequester.find((entry) => entry.id === secret.id);
  assert.ok(recovered, "the original requester recovered from the task record can still list the outcome");
  assert.equal(recovered?.accessScope, "workroom");
  assert.equal(recovered?.requesterId, "requester");

  const asController = await store.list(project, { access: controller });
  assert.ok(asController.some((entry) => entry.id === secret.id), "a project controller can list the recovered outcome");

  await store.promote(project, secret.id);
  const requesterRecall = await store.recallFor(project, "private workroom secret outcome to recover", requester);
  assert.ok(requesterRecall.some((entry) => entry.id === secret.id), "after promotion the requester can recall the outcome");
  const otherViewerRecall = await store.recallFor(project, "private workroom secret outcome to recover", otherViewer);
  assert.ok(!otherViewerRecall.some((entry) => entry.id === secret.id), "recall still respects the recovered workroom scope");

  await assert.rejects(() => stat(legacyFile), "the legacy file is retired after a successful recovery");
});
