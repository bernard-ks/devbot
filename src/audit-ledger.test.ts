import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuditLedger,
  formatAuditVerification,
  isAuditRecordVisible,
  type AuditEventInput,
  type AuditRecord
} from "./audit-ledger.js";
import { commandDefinitions } from "./commands.js";
import { CollabStore } from "./collab-store.js";
import { commandRequiresController } from "./safety.js";
import { TaskStore } from "./task-store.js";

const GENESIS_HASH = "0".repeat(64);

test("audit ledger appends, reloads, and verifies a hash-chained sequence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-roundtrip-"));
  const ledger = new AuditLedger(directory);
  for (let index = 1; index <= 6; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  const reloaded = new AuditLedger(directory);
  const recent = await reloaded.recent({ limit: 10 });
  assert.equal(recent.length, 6);
  assert.equal(recent[0]?.seq, 6);
  assert.equal(recent.at(-1)?.seq, 1);
  assert.equal((await reloaded.show(3))?.actor, "user-3");
  assert.deepEqual((await reloaded.recent({ limit: 10, project: "webapp" })).map((record) => record.seq), [6, 5, 4, 3, 2, 1]);

  const verification = await reloaded.verify();
  assert.equal(verification.ok, true);
  assert.equal(verification.records, 6);
  assert.equal(verification.files, 1);
  assert.equal(verification.firstSeq, 1);
  assert.equal(verification.lastSeq, 6);
  assert.equal(verification.prunedPrefix, false);
  assert.equal(verification.anchor, "match");

  const records = await parsedLedgerRecords(directory);
  assert.equal(records[0]?.prevHash, GENESIS_HASH);
  for (let index = 1; index < records.length; index += 1) {
    assert.equal(records[index]?.prevHash, records[index - 1]?.hash);
  }
});

test("tampering with a middle record is reported at exactly its sequence and reads fail closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-tamper-"));
  const ledger = new AuditLedger(directory);
  for (let index = 1; index <= 8; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  const filePath = path.join(directory, (await ledgerFileNames(directory))[0]!);
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  const tampered = lines.map((line) => {
    const record = JSON.parse(line) as AuditRecord;
    if (record.seq !== 4) return line;
    return JSON.stringify({ ...record, summary: "history rewritten" });
  });
  await writeFile(filePath, `${tampered.join("\n")}\n`, "utf8");

  const verification = await new AuditLedger(directory).verify();
  assert.equal(verification.ok, false);
  assert.equal(verification.failure?.seq, 4);
  assert.match(verification.failure?.reason ?? "", /stored hash/);
  assert.match(formatAuditVerification(verification), /seq 4/);
  await assert.rejects(new AuditLedger(directory).recent(), /failed integrity checks/);
});

test("a tampered tail refuses further appends instead of extending a forged chain", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-tail-tamper-"));
  const ledger = new AuditLedger(directory);
  await ledger.record(sampleEvent(1));
  await ledger.record(sampleEvent(2));

  const filePath = path.join(directory, (await ledgerFileNames(directory))[0]!);
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  const tail = JSON.parse(lines.at(-1)!) as AuditRecord;
  lines[lines.length - 1] = JSON.stringify({ ...tail, actor: "attacker" });
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

  await assert.rejects(new AuditLedger(directory).record(sampleEvent(3)), /failed its hash check/);
});

test("truncating the ledger tail is detected through the head anchor", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-truncate-"));
  const ledger = new AuditLedger(directory);
  for (let index = 1; index <= 5; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  const filePath = path.join(directory, (await ledgerFileNames(directory))[0]!);
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  await writeFile(filePath, `${lines.slice(0, -1).join("\n")}\n`, "utf8");

  const verification = await new AuditLedger(directory).verify();
  assert.equal(verification.ok, false);
  assert.equal(verification.failure, undefined);
  assert.equal(verification.anchor, "divergent");
  assert.match(formatAuditVerification(verification), /anchor/i);
  await assert.rejects(new AuditLedger(directory).record(sampleEvent(6)), /diverges from its anchor/);
});

test("a divergent head anchor makes ordinary reads fail closed, not only verify", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-read-failclosed-"));
  const ledger = new AuditLedger(directory);
  for (let index = 1; index <= 5; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  // Roll the chain back by one record while the head anchor still points at seq 5.
  const filePath = path.join(directory, (await ledgerFileNames(directory))[0]!);
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  await writeFile(filePath, `${lines.slice(0, -1).join("\n")}\n`, "utf8");

  const reader = new AuditLedger(directory);
  assert.equal((await reader.verify()).anchor, "divergent");
  await assert.rejects(reader.records(), /anchor diverges/);
  await assert.rejects(reader.recent({ limit: 5 }), /anchor diverges/);
  await assert.rejects(reader.show(3), /anchor diverges/);
});

test("an interrupted anchor write does not let a later append reuse the sequence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-anchor-fault-"));
  const ledger = new AuditLedger(directory);
  await ledger.record(sampleEvent(1));
  await ledger.record(sampleEvent(2));

  const original = (ledger as unknown as { writeAnchor: (anchor: unknown) => Promise<void> }).writeAnchor.bind(ledger);
  let failNext = true;
  (ledger as unknown as { writeAnchor: (anchor: unknown) => Promise<void> }).writeAnchor = async (anchor: unknown) => {
    if (failNext) {
      failNext = false;
      throw new Error("simulated anchor write failure");
    }
    return original(anchor);
  };

  // The seq-3 line is fsynced to disk, then the anchor update fails.
  await assert.rejects(ledger.record(sampleEvent(3)), /simulated anchor write failure/);
  assert.equal((await ledger.health()).ok, false);

  // The next append must reload the true head from disk and continue at seq 4,
  // never reusing seq 3, and it reconciles the interrupted anchor update.
  await ledger.record(sampleEvent(4));

  const records = await ledger.records();
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3, 4]);
  const seqs = new Set(records.map((record) => record.seq));
  assert.equal(seqs.size, records.length);
  const verification = await ledger.verify();
  assert.equal(verification.ok, true);
  assert.equal(verification.anchor, "match");
  assert.equal(verification.lastSeq, 4);
});

test("a tampered middle record blocks future appends instead of extending a forged chain", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-middle-tamper-"));
  const ledger = new AuditLedger(directory);
  for (let index = 1; index <= 8; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  const filePath = path.join(directory, (await ledgerFileNames(directory))[0]!);
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  const tampered = lines.map((line) => {
    const record = JSON.parse(line) as AuditRecord;
    if (record.seq !== 4) return line;
    return JSON.stringify({ ...record, summary: "history rewritten" });
  });
  await writeFile(filePath, `${tampered.join("\n")}\n`, "utf8");

  await assert.rejects(new AuditLedger(directory).record(sampleEvent(9)), /integrity checks/);
});

test("a wrong-hash behind anchor refuses appends and is not silently rewritten", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-wrong-hash-behind-"));
  const ledger = new AuditLedger(directory);
  for (let index = 1; index <= 5; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  // Point the anchor at an earlier sequence but with a hash that does not match
  // the retained record there. A cold append must cross-check this and refuse,
  // rather than reconciling it as an interrupted (behind) anchor update.
  const forgedAnchor = { version: 1, seq: 3, hash: "b".repeat(64), updatedAt: new Date().toISOString() };
  await writeFile(path.join(directory, "head.json"), `${JSON.stringify(forgedAnchor, null, 2)}\n`, "utf8");
  assert.equal((await new AuditLedger(directory).verify()).anchor, "divergent");

  await assert.rejects(new AuditLedger(directory).record(sampleEvent(6)), /diverges from its anchor/);

  // The rejected append must not repair the anchor: the forged hash is still on
  // disk and verify still reports divergence.
  const persisted = JSON.parse(await readFile(path.join(directory, "head.json"), "utf8")) as { seq: number; hash: string };
  assert.equal(persisted.seq, 3);
  assert.equal(persisted.hash, "b".repeat(64));
  assert.equal((await new AuditLedger(directory).verify()).anchor, "divergent");
});

test("a malformed head anchor refuses appends without rewriting it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-malformed-anchor-"));
  const ledger = new AuditLedger(directory);
  for (let index = 1; index <= 4; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  const anchorPath = path.join(directory, "head.json");
  const malformed = "{ this is not valid anchor json";
  await writeFile(anchorPath, malformed, "utf8");
  assert.equal((await new AuditLedger(directory).verify()).anchor, "divergent");

  await assert.rejects(new AuditLedger(directory).record(sampleEvent(5)), /diverges from its anchor/);
  assert.equal(await readFile(anchorPath, "utf8"), malformed);
});

test("a missing anchor on a nonempty ledger fails closed and is not recreated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-missing-anchor-"));
  const ledger = new AuditLedger(directory);
  for (let index = 1; index <= 4; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  const anchorPath = path.join(directory, "head.json");
  await rm(anchorPath);
  assert.equal((await new AuditLedger(directory).verify()).anchor, "missing");

  await assert.rejects(new AuditLedger(directory).record(sampleEvent(5)), /head anchor is missing/);
  await assert.rejects(stat(anchorPath), /ENOENT/);
});

test("rotation chains files together and retention prunes to an anchored prefix", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-rotation-"));
  const ledger = new AuditLedger(directory, { maxFileBytes: 10, maxFiles: 3 });
  for (let index = 1; index <= 6; index += 1) {
    await ledger.record(sampleEvent(index));
  }

  const fileNames = await ledgerFileNames(directory);
  assert.deepEqual(fileNames, ["ledger-000004.jsonl", "ledger-000005.jsonl", "ledger-000006.jsonl"]);
  const verification = await new AuditLedger(directory).verify();
  assert.equal(verification.ok, true);
  assert.equal(verification.records, 3);
  assert.equal(verification.firstSeq, 4);
  assert.equal(verification.lastSeq, 6);
  assert.equal(verification.prunedPrefix, true);
  assert.equal(verification.anchor, "match");
  assert.match(formatAuditVerification(verification), /pruned by retention/);

  const multiDirectory = await mkdtemp(path.join(tmpdir(), "devbot-audit-rotation-multi-"));
  const multiLedger = new AuditLedger(multiDirectory, { maxFileBytes: 700 });
  for (let index = 1; index <= 6; index += 1) {
    await multiLedger.record(sampleEvent(index));
  }
  const multiFiles = await ledgerFileNames(multiDirectory);
  assert.equal(multiFiles.length >= 2, true);
  const firstFileRecords = await parsedFileRecords(path.join(multiDirectory, multiFiles[0]!));
  const secondFileRecords = await parsedFileRecords(path.join(multiDirectory, multiFiles[1]!));
  assert.equal(firstFileRecords.length >= 2, true);
  assert.equal(secondFileRecords[0]?.prevHash, firstFileRecords.at(-1)?.hash);
  const multiVerification = await new AuditLedger(multiDirectory).verify();
  assert.equal(multiVerification.ok, true);
  assert.equal(multiVerification.records, 6);
  assert.equal(multiVerification.files, multiFiles.length);
});

test("ledger directory, chain files, and anchor are owner-only", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not enforced on Windows.");
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-permissions-"));
  const ledger = new AuditLedger(directory, { maxFileBytes: 10 });
  await ledger.record(sampleEvent(1));
  await ledger.record(sampleEvent(2));

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const fileName of await ledgerFileNames(directory)) {
    assert.equal((await stat(path.join(directory, fileName))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(path.join(directory, "head.json"))).mode & 0o777, 0o600);
});

test("secret-bearing payloads are redacted before hashing and persisting", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devbot-audit-redaction-"));
  const ledger = new AuditLedger(directory);
  const githubToken = `github_pat_${"A".repeat(30)}`;
  await ledger.record({
    type: "command.executed",
    actor: "user#1",
    subject: "command:deploy",
    project: "webapp",
    summary: `deploy with ${githubToken} and password=hunter2secret`
  });

  for (const fileName of await ledgerFileNames(directory)) {
    const content = await readFile(path.join(directory, fileName), "utf8");
    assert.equal(content.includes(githubToken), false);
    assert.equal(content.includes("hunter2secret"), false);
    assert.match(content, /\[REDACTED/);
  }
  const [record] = await new AuditLedger(directory).recent({ limit: 1 });
  assert.equal(record?.summary.includes(githubToken), false);
  assert.equal((await new AuditLedger(directory).verify()).ok, true);
});

test("audit append failures never break the wrapped task mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-audit-append-failure-"));
  const store = new TaskStore(path.join(root, "tasks.json"));
  store.setAuditor({
    record: async () => {
      throw new Error("audit disk full");
    }
  });

  const proposal = await store.propose(taskInput("propose something"));
  assert.equal(proposal.status, "awaiting-approval");
  const started = await store.begin(proposal.id, { actor: "owner#1" });
  assert.equal(started?.status, "running");
  assert.equal(await store.succeed(proposal.id, {}), true);
  assert.equal((await new TaskStore(path.join(root, "tasks.json")).get(proposal.id))?.status, "succeeded");
});

test("task lifecycle, approvals, and collab decisions land in the ledger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-audit-wiring-"));
  const ledger = new AuditLedger(path.join(root, "audit"));
  const tasks = new TaskStore(path.join(root, "tasks.json"));
  tasks.setAuditor(ledger);
  const collab = new CollabStore(path.join(root, "collab.json"));
  collab.setAuditor(ledger);

  const approved = await tasks.propose(taskInput("approved work"));
  await tasks.begin(approved.id, { actor: "controller#1" });
  await tasks.succeed(approved.id, {});
  const declined = await tasks.propose(taskInput("declined work"));
  await tasks.deny(declined.id, "owner#1");
  const running = await tasks.start(taskInput("direct work"));
  await tasks.cancel(running.id, "Canceled by owner#1.");
  const failing = await tasks.start(taskInput("failing work"));
  await tasks.fail(failing.id, new Error("build exploded"));

  const conversation = await collab.start({
    intent: "roundtable",
    projectName: "webapp",
    title: "Ship it?",
    requester: "owner#1"
  });
  await collab.decide({ conversationId: conversation.id, outcome: "deny", actor: "owner#1", note: "not yet" });

  const records = await ledger.records();
  assert.deepEqual(
    records.map((record) => record.type),
    [
      "task.proposed",
      "task.approved",
      "task.completed",
      "task.proposed",
      "approval.denied",
      "task.started",
      "task.canceled",
      "task.started",
      "task.failed",
      "collab.decided"
    ]
  );
  assert.equal(records[1]?.actor, "controller#1");
  assert.equal(records[1]?.subject, approved.id);
  assert.equal(records[4]?.actor, "owner#1");
  assert.equal(records.at(-1)?.project, "webapp");
  assert.match(records.at(-1)?.summary ?? "", /deny: not yet/);
  assert.equal(records.every((record) => record.project === "webapp"), true);
  assert.equal((await ledger.verify()).ok, true);
});

test("/audit is controller-gated and records stay project-scoped for non-owners", () => {
  assert.equal(commandRequiresController("audit", "recent"), true);
  assert.equal(commandRequiresController("audit", "show"), true);
  assert.equal(commandRequiresController("audit", "verify"), true);
  assert.equal(commandRequiresController("do", undefined), true);
  assert.equal(commandRequiresController("run", undefined), true);
  assert.equal(commandRequiresController("task", "recent"), false);
  assert.equal(commandRequiresController("projects", undefined), false);

  const audit = commandDefinitions.find((command) => command.name === "audit");
  assert.deepEqual(audit?.options?.map((option) => option.name), ["recent", "show", "verify"]);

  const scoped = fakeRecord("webapp");
  const unscoped = fakeRecord("");
  assert.equal(isAuditRecordVisible(scoped, { ownerView: true, visibleProjects: new Set() }), true);
  assert.equal(isAuditRecordVisible(scoped, { ownerView: false, visibleProjects: new Set() }), false);
  assert.equal(isAuditRecordVisible(scoped, { ownerView: false, visibleProjects: new Set(["webapp"]) }), true);
  assert.equal(isAuditRecordVisible(unscoped, { ownerView: false, visibleProjects: new Set() }), true);
  assert.equal(isAuditRecordVisible(scoped, { ownerView: false, visibleProjects: new Set(), projectFilter: "webapp" }), false);
  assert.equal(isAuditRecordVisible(unscoped, { ownerView: true, visibleProjects: new Set(), projectFilter: "webapp" }), false);
});

function sampleEvent(index: number): AuditEventInput {
  return {
    type: "task.started",
    actor: `user-${index}`,
    subject: `task-${index}`,
    project: "webapp",
    summary: `event ${index}`
  };
}

function taskInput(text: string) {
  return {
    source: "test",
    mode: "action",
    projectName: "webapp",
    requester: "requester#1",
    text
  };
}

function fakeRecord(project: string): AuditRecord {
  return {
    version: 1,
    seq: 1,
    timestamp: new Date().toISOString(),
    type: "task.started",
    actor: "user#1",
    subject: "task-1",
    project,
    summary: "event",
    prevHash: GENESIS_HASH,
    hash: "a".repeat(64)
  };
}

async function ledgerFileNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.startsWith("ledger-")).sort();
}

async function parsedFileRecords(filePath: string): Promise<AuditRecord[]> {
  return (await readFile(filePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditRecord);
}

async function parsedLedgerRecords(directory: string): Promise<AuditRecord[]> {
  const records: AuditRecord[] = [];
  for (const fileName of await ledgerFileNames(directory)) {
    records.push(...(await parsedFileRecords(path.join(directory, fileName))));
  }
  return records;
}
