import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TunnelProcessLedger, type TunnelProcessRecord } from "./tunnel-ledger.js";

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
    ...overrides
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
    commandForPid: async () => undefined,
    killPid: () => assert.fail("must not signal a dead pid"),
    sleepMs: async () => {}
  });
  assert.deepEqual(summary, { alreadyGone: 1, killed: 0, unverified: 0, survived: 0 });
  assert.deepEqual(ledger.list(), []);
});

test("reconcile SIGTERMs a surviving cloudflared, escalates to SIGKILL, and clears the record once it dies", async () => {
  const filePath = await ledgerPath();
  await new TunnelProcessLedger(filePath).record(record({ id: "orphan", pid: 901 }));

  const signals: NodeJS.Signals[] = [];
  let alive = true;
  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => alive,
    commandForPid: async () => "/opt/homebrew/bin/cloudflared",
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
  await new TunnelProcessLedger(filePath).record(record({ id: "recycled", pid: 902 }));

  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => true,
    commandForPid: async () => "/usr/bin/some-unrelated-daemon",
    killPid: () => assert.fail("must not signal a pid it cannot identify as cloudflared"),
    sleepMs: async () => {}
  });
  assert.deepEqual(summary, { alreadyGone: 1, killed: 0, unverified: 0, survived: 0 });
  assert.deepEqual(ledger.list(), []);
});

test("reconcile keeps records it cannot verify or cannot kill, so the next startup retries", async () => {
  const filePath = await ledgerPath();
  const seed = new TunnelProcessLedger(filePath);
  await seed.record(record({ id: "unverified", pid: 903 }));
  await seed.record(record({ id: "immortal", pid: 904 }));

  const ledger = new TunnelProcessLedger(filePath);
  const summary = await ledger.reconcile({
    isAlive: () => true,
    commandForPid: async (pid) => (pid === 904 ? "cloudflared" : undefined),
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
    commandForPid: async () => undefined,
    killPid: () => {},
    sleepMs: async () => {}
  });
  assert.deepEqual(inspected, [905]);
  assert.deepEqual(summary, { alreadyGone: 1, killed: 0, unverified: 0, survived: 0 });
  assert.deepEqual(ledger.list().map((entry) => entry.id), ["this-run"]);
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
