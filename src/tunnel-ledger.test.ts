import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseProcessIdentityLine,
  TunnelProcessLedger,
  type ProcessIdentity,
  type TunnelProcessRecord
} from "./tunnel-ledger.js";

async function ledgerPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "devbot-tunnel-ledger-"));
  return path.join(dir, "preview-tunnels.json");
}

function record(overrides: Partial<TunnelProcessRecord> = {}): TunnelProcessRecord {
  return {
    id: "tunnel-1",
    pid: 40_001,
    origin: "http://127.0.0.1:3000",
    createdAt: "2026-07-10T00:00:00.000Z",
    pgid: 40_001,
    startTime: "Fri Jul 10 00:00:00 2026",
    argvSignature: "tunnel --url http://127.0.0.1:3000",
    ...overrides
  };
}

/** A live `ps` identity that matches `record` on every durable field (command is still cloudflared). */
function matchingIdentity(entry: TunnelProcessRecord): ProcessIdentity {
  return {
    command: `/opt/homebrew/bin/cloudflared ${entry.argvSignature ?? ""}`,
    ...(entry.pgid !== undefined ? { pgid: entry.pgid } : {}),
    ...(entry.startTime !== undefined ? { startTime: entry.startTime } : {})
  };
}

test("TunnelProcessLedger persists records across instances and releases them by id", async () => {
  const filePath = await ledgerPath();
  const ledger = new TunnelProcessLedger(filePath);
  await ledger.record(record({ id: "a", pid: 101 }));
  await ledger.record(record({ id: "b", pid: 102 }));

  const reloaded = new TunnelProcessLedger(filePath);
  assert.deepEqual(reloaded.list().map((entry) => entry.id).sort(), ["a", "b"]);

  await ledger.release("a");
  const afterRelease = new TunnelProcessLedger(filePath);
  assert.deepEqual(afterRelease.list().map((entry) => entry.id), ["b"]);
});

test("TunnelProcessLedger tolerates a corrupt or malformed state file by starting empty", async () => {
  const filePath = await ledgerPath();
  await writeFile(filePath, "not json", "utf8");
  assert.deepEqual(new TunnelProcessLedger(filePath).list(), []);

  await writeFile(filePath, JSON.stringify([{ id: "", pid: -1 }, { id: "ok", pid: 55 }]), "utf8");
  assert.deepEqual(new TunnelProcessLedger(filePath).list().map((entry) => entry.id), ["ok"]);
});

test("reconcile drops records whose process is already gone", async () => {
  const filePath = await ledgerPath();
  await new TunnelProcessLedger(filePath).record(record({ id: "gone", pid: 900 }));

  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => false,
    identifyProcess: async () => undefined,
    killPid: () => assert.fail("must not signal a dead pid"),
    sleepMs: async () => {}
  });
  assert.deepEqual(summary, { alreadyGone: 1, killed: 0, unverified: 0, survived: 0 });
  assert.deepEqual(ledger.list(), []);
});

test("reconcile SIGTERMs a surviving cloudflared, escalates to SIGKILL, and clears the record once it dies", async () => {
  const filePath = await ledgerPath();
  const orphan = record({ id: "orphan", pid: 901, pgid: 901 });
  await new TunnelProcessLedger(filePath).record(orphan);

  const signals: NodeJS.Signals[] = [];
  let alive = true;
  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => alive,
    identifyProcess: async () => matchingIdentity(orphan),
    killPid: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    },
    sleepMs: async () => {},
    killGraceMs: 0
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(summary, { alreadyGone: 0, killed: 1, unverified: 0, survived: 0 });
  assert.deepEqual(ledger.list(), []);
});

test("reconcile never signals a recycled pid that is no longer cloudflared, and drops its record", async () => {
  const filePath = await ledgerPath();
  await new TunnelProcessLedger(filePath).record(record({ id: "recycled", pid: 902, pgid: 902 }));

  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => true,
    identifyProcess: async () => ({ command: "/usr/bin/some-unrelated-daemon", pgid: 902, startTime: "Fri Jul 10 00:00:00 2026" }),
    killPid: () => assert.fail("must not signal a pid it cannot identify as cloudflared"),
    sleepMs: async () => {}
  });
  assert.deepEqual(summary, { alreadyGone: 1, killed: 0, unverified: 0, survived: 0 });
  assert.deepEqual(ledger.list(), []);
});

test("reconcile never signals a recycled pid whose durable identity no longer matches, even when it is another cloudflared", async () => {
  const filePath = await ledgerPath();
  const original = record({ id: "recycled-cf", pid: 950, pgid: 950, startTime: "Fri Jul 10 00:00:00 2026" });
  await new TunnelProcessLedger(filePath).record(original);

  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => true,
    // Same pid, still a cloudflared, same argv signature — but a DIFFERENT
    // process: the kernel start time and process group belong to a newer
    // cloudflared that reused the pid. This is exactly the recycled-pid case
    // the review flagged; it must not be signalled.
    identifyProcess: async () => ({
      command: `/opt/homebrew/bin/cloudflared ${original.argvSignature}`,
      pgid: 951,
      startTime: "Fri Jul 10 09:15:42 2026"
    }),
    killPid: () => assert.fail("must not signal a pid whose start time / pgid no longer match the recorded identity"),
    sleepMs: async () => {}
  });
  assert.deepEqual(summary, { alreadyGone: 1, killed: 0, unverified: 0, survived: 0 });
  assert.deepEqual(ledger.list(), []);
});

test("reconcile refuses to signal a live pid when the stored record lacks a full durable identity", async () => {
  const filePath = await ledgerPath();
  // A record missing pgid/startTime/argvSignature (hand-written or partial)
  // can never be positively proven to be the cloudflared it recorded, so it is
  // kept as unverified for a human to inspect and never signalled.
  await writeFile(
    filePath,
    JSON.stringify([{ id: "partial", pid: 960, origin: "http://127.0.0.1:3000", createdAt: "2026-07-10T00:00:00.000Z" }]),
    "utf8"
  );

  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => true,
    identifyProcess: async () => ({
      command: "/opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:3000",
      pgid: 960,
      startTime: "Fri Jul 10 00:00:00 2026"
    }),
    killPid: () => assert.fail("must not signal a record without a full durable identity"),
    sleepMs: async () => {}
  });
  assert.deepEqual(summary, { alreadyGone: 0, killed: 0, unverified: 1, survived: 0 });
  assert.deepEqual(ledger.list().map((entry) => entry.id), ["partial"]);
});

test("reconcile keeps records it cannot verify or cannot kill, so the next startup retries", async () => {
  const filePath = await ledgerPath();
  const seed = new TunnelProcessLedger(filePath);
  await seed.record(record({ id: "unverified", pid: 903, pgid: 903 }));
  const immortal = record({ id: "immortal", pid: 904, pgid: 904 });
  await seed.record(immortal);

  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => true,
    identifyProcess: async (pid) => (pid === 904 ? matchingIdentity(immortal) : undefined),
    killPid: () => {},
    sleepMs: async () => {},
    killGraceMs: 0
  });
  assert.deepEqual(summary, { alreadyGone: 0, killed: 0, unverified: 1, survived: 1 });
  assert.deepEqual(ledger.list().map((entry) => entry.id).sort(), ["immortal", "unverified"]);
});

test("reconcile only touches records that existed at startup, never tunnels recorded by this runtime", async () => {
  const filePath = await ledgerPath();
  await new TunnelProcessLedger(filePath).record(record({ id: "previous-run", pid: 905 }));

  const ledger = new TunnelProcessLedger(filePath);
  await ledger.record(record({ id: "this-run", pid: 906 }));
  const inspected: number[] = [];
  const summary = await ledger.reconcile({
    isAlive: (pid) => {
      inspected.push(pid);
      return false;
    },
    identifyProcess: async () => undefined,
    killPid: () => {},
    sleepMs: async () => {}
  });
  assert.deepEqual(inspected, [905]);
  assert.deepEqual(summary, { alreadyGone: 1, killed: 0, unverified: 0, survived: 0 });
  assert.deepEqual(ledger.list().map((entry) => entry.id), ["this-run"]);
});

test("ledger persists and reloads the durable process identity fields", async () => {
  const filePath = await ledgerPath();
  await new TunnelProcessLedger(filePath).record(
    record({ id: "durable", pid: 970, pgid: 970, startTime: "Fri Jul 10 12:00:00 2026", argvSignature: "tunnel --url http://127.0.0.1:5173" })
  );
  const [reloaded] = new TunnelProcessLedger(filePath).list();
  assert.equal(reloaded?.pgid, 970);
  assert.equal(reloaded?.startTime, "Fri Jul 10 12:00:00 2026");
  assert.equal(reloaded?.argvSignature, "tunnel --url http://127.0.0.1:5173");
});

test("parseProcessIdentityLine splits pgid, the five-field lstart, and the full command", () => {
  const identity = parseProcessIdentityLine("  951 Fri Jul 10 12:34:56 2026 /opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:3000\n");
  assert.deepEqual(identity, {
    pgid: 951,
    startTime: "Fri Jul 10 12:34:56 2026",
    command: "/opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:3000"
  });
  assert.equal(parseProcessIdentityLine(""), undefined);
  assert.equal(parseProcessIdentityLine("garbage-without-fields"), undefined);
});

test("ledger file is written private (0600) with a trailing newline", async () => {
  const filePath = await ledgerPath();
  const ledger = new TunnelProcessLedger(filePath);
  await ledger.record(record());
  const raw = await readFile(filePath, "utf8");
  assert.ok(raw.endsWith("\n"));
  if (process.platform !== "win32") {
    const { stat } = await import("node:fs/promises");
    const mode = (await stat(filePath)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});
