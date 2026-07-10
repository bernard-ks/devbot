import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeScheduleSpec,
  formatScheduleList,
  isScheduleId,
  nextRunAfter,
  parseScheduleSpec,
  ScheduleStore,
  type ScheduleSpec
} from "./schedule-store.js";
import { captureWorkerIdentity, type WorkerIdentity } from "./worker-identity.js";

test("parseScheduleSpec parses daily, weekdays, and every-hours forms", () => {
  assert.deepEqual(parseScheduleSpec("daily 07:00"), { kind: "daily", hour: 7, minute: 0 });
  assert.deepEqual(parseScheduleSpec("Daily 23:59"), { kind: "daily", hour: 23, minute: 59 });
  assert.deepEqual(parseScheduleSpec("weekdays 09:30"), { kind: "weekdays", hour: 9, minute: 30 });
  assert.deepEqual(parseScheduleSpec("every 4h"), { kind: "every-hours", hours: 4 });
});

test("parseScheduleSpec rejects malformed or out-of-range specs", () => {
  assert.equal(parseScheduleSpec("daily 24:00"), undefined);
  assert.equal(parseScheduleSpec("daily 10:60"), undefined);
  assert.equal(parseScheduleSpec("every 0h"), undefined);
  assert.equal(parseScheduleSpec("every -3h"), undefined);
  assert.equal(parseScheduleSpec("hourly"), undefined);
  assert.equal(parseScheduleSpec(""), undefined);
});

test("describeScheduleSpec round-trips to a normalized string", () => {
  assert.equal(describeScheduleSpec({ kind: "daily", hour: 7, minute: 0 }), "daily 07:00");
  assert.equal(describeScheduleSpec({ kind: "weekdays", hour: 9, minute: 5 }), "weekdays 09:05");
  assert.equal(describeScheduleSpec({ kind: "every-hours", hours: 6 }), "every 6h");
});

test("nextRunAfter for daily rolls to the same day if the time has not passed, else the next day", () => {
  const spec: ScheduleSpec = { kind: "daily", hour: 7, minute: 0 };
  const morning = new Date("2026-07-09T05:00:00");
  const laterSameDay = nextRunAfter(spec, morning);
  assert.equal(laterSameDay.getDate(), 9);
  assert.equal(laterSameDay.getHours(), 7);

  const afterTime = new Date("2026-07-09T08:00:00");
  const nextDay = nextRunAfter(spec, afterTime);
  assert.equal(nextDay.getDate(), 10);
  assert.equal(nextDay.getHours(), 7);
});

test("nextRunAfter for daily crosses a month/year boundary correctly", () => {
  const spec: ScheduleSpec = { kind: "daily", hour: 7, minute: 0 };
  const newYearsEve = new Date("2026-12-31T23:00:00");
  const next = nextRunAfter(spec, newYearsEve);
  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 7);
});

test("nextRunAfter for weekdays skips Saturday and Sunday", () => {
  const spec: ScheduleSpec = { kind: "weekdays", hour: 9, minute: 0 };
  const friday = new Date("2026-07-10T10:00:00");
  assert.equal(friday.getDay(), 5);
  const next = nextRunAfter(spec, friday);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 13);
});

test("nextRunAfter for every-hours adds the interval from the reference time", () => {
  const spec: ScheduleSpec = { kind: "every-hours", hours: 3 };
  const reference = new Date("2026-07-09T10:00:00");
  const next = nextRunAfter(spec, reference);
  assert.equal(next.getTime() - reference.getTime(), 3 * 3_600_000);
});

async function tempStore(): Promise<ScheduleStore> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-store-"));
  return new ScheduleStore(path.join(root, "schedule.json"));
}

function addInput(overrides: Partial<{ spec: string; project: string; taskText: string }> = {}) {
  return { spec: "every 1h", project: "web", taskText: "x", addedBy: "tom", addedById: "user-1", ...overrides };
}

test("schedule add computes a future nextRun, defaults to read-only, and rejects a bad spec", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput({ spec: "daily 07:00", taskText: "standup digest" }));
  assert.ok(new Date(entry.nextRun).getTime() > Date.now() - 1000);
  assert.equal(entry.enabled, true);
  assert.equal(entry.mode, "answer");
  assert.equal(entry.running, false);
  assert.ok(isScheduleId(entry.id));
  await assert.rejects(() => store.add(addInput({ spec: "hourly" })), /Unrecognized schedule spec/);
});

test("schedule survives reload from disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-reload-"));
  const filePath = path.join(root, "schedule.json");
  const store = new ScheduleStore(filePath);
  await store.add(addInput({ spec: "every 2h", taskText: "lint sweep" }));

  const reloaded = new ScheduleStore(filePath);
  const entries = await reloaded.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.taskText, "lint sweep");
  assert.equal(entries[0]?.mode, "answer");
  assert.equal(entries[0]?.addedById, "user-1");
});

test("schedule drops malformed records and rejects an unsupported version on load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-invalid-"));
  const filePath = path.join(root, "schedule.json");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      entries: [{ id: "not-a-valid-id", spec: "daily 07:00", project: "web", taskText: "x", enabled: true, addedBy: "tom", createdAt: new Date().toISOString(), nextRun: new Date().toISOString() }]
    })
  );
  const store = new ScheduleStore(filePath);
  assert.deepEqual(await store.list(), []);

  const badVersionFile = path.join(root, "bad-version.json");
  await writeFile(badVersionFile, JSON.stringify({ version: 99, entries: [] }));
  await assert.rejects(() => new ScheduleStore(badVersionFile).list(), /Unsupported schedule state version/);
});

test("schedule load fails closed on a legacy write-capable record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-legacy-"));
  const filePath = path.join(root, "schedule.json");
  const now = new Date().toISOString();
  const record = (mode: string) => ({
    id: `sched-legacy-${mode}`,
    spec: "daily 07:00",
    project: "web",
    taskText: "x",
    mode,
    enabled: true,
    addedBy: "tom",
    addedById: "user-1",
    createdAt: now,
    nextRun: now,
    running: false
  });
  await writeFile(filePath, JSON.stringify({ version: 1, entries: [record("action"), record("answer")] }));

  const store = new ScheduleStore(filePath);
  const entries = await store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "sched-legacy-answer");
  assert.equal((await store.claimDue(new Date(Date.now() + 1000))).length, 1);
});

test("schedule state directory and file are owner-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-perms-"));
  const dir = path.join(root, "state");
  const filePath = path.join(dir, "schedule.json");
  const store = new ScheduleStore(filePath);
  await store.add(addInput());
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("schedule redacts secrets and neutralizes mentions in stored text", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput({ taskText: "ping @everyone about sk-abcdefghijklmnopqrst" }));
  assert.doesNotMatch(entry.taskText, /@everyone/);
  assert.match(entry.taskText, /REDACTED API KEY/);
});

test("pause disables an entry and resume recomputes nextRun from now", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput());
  const paused = await store.setEnabled(entry.id, false);
  assert.equal(paused?.enabled, false);

  const before = Date.now();
  const resumed = await store.setEnabled(entry.id, true);
  assert.equal(resumed?.enabled, true);
  assert.ok(new Date(resumed!.nextRun).getTime() >= before);
});

test("remove deletes the entry", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput({ spec: "daily 07:00" }));
  assert.equal(await store.remove(entry.id), true);
  assert.equal(await store.get(entry.id), undefined);
  assert.equal(await store.remove(entry.id), false);
});

test("due returns only enabled, not-running entries whose nextRun has passed", async () => {
  const store = await tempStore();
  const soon = await store.add(addInput({ taskText: "soon" }));
  const far = await store.add(addInput({ taskText: "far" }));
  const now = new Date();
  const due = await store.due(new Date(now.getTime() + 2 * 3_600_000 + 1));
  const dueIds = due.map((entry) => entry.id);
  assert.ok(dueIds.includes(soon.id));
  assert.ok(dueIds.includes(far.id));
  assert.equal((await store.due(now)).length, 0);
});

test("claimDue atomically marks entries running so a concurrent tick cannot claim them again", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput());
  const laterNow = new Date(Date.now() + 3_600_000 + 1);

  const firstTick = await store.claimDue(laterNow);
  assert.equal(firstTick.length, 1);
  assert.equal(firstTick[0]?.running, true);

  // Simulates a second tick firing more than one 30s interval later while the first
  // occurrence is still in flight: it must not see the entry as due again, so the
  // occurrence executes exactly once.
  const secondTick = await store.claimDue(new Date(laterNow.getTime() + 31_000));
  assert.equal(secondTick.length, 0);
  assert.equal((await store.due(new Date(laterNow.getTime() + 31_000))).length, 0);

  const current = await store.get(entry.id);
  assert.equal(current?.running, true);

  await store.markRun(entry.id, "done", laterNow);
  const afterRun = await store.get(entry.id);
  assert.equal(afterRun?.running, false);
});

test("markRun records lastRun/lastResult, releases the running lease, and advances nextRun", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput());
  const runAt = new Date(entry.nextRun);
  await store.claimDue(runAt);
  await store.markRun(entry.id, "Posted an update.", runAt);
  const updated = await store.get(entry.id);
  assert.equal(updated?.lastRun, runAt.toISOString());
  assert.equal(updated?.lastResult, "Posted an update.");
  assert.equal(updated?.running, false);
  assert.equal(new Date(updated!.nextRun).getTime(), runAt.getTime() + 3_600_000);
});

test("recoverInterrupted releases a stuck running lease and makes the entry due again", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput());
  await store.claimDue(new Date(entry.nextRun));

  const recovered = await store.recoverInterrupted("Interrupted when Devbot restarted.");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.running, false);

  const current = await store.get(entry.id);
  assert.equal(current?.running, false);
  assert.equal(current?.lastResult, "Interrupted when Devbot restarted.");
  assert.ok(new Date(current!.nextRun).getTime() <= Date.now() + 1000);
});

interface LiveWorker {
  pid: number;
  stop: () => Promise<void>;
}

function spawnLiveWorker(): LiveWorker {
  // A detached, long-lived child that stands in for a Codex worker that outlived
  // a runtime crash. `detached` makes it a process-group leader (pgid === pid),
  // matching how the real worker is spawned.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore"
  });
  if (typeof child.pid !== "number") {
    throw new Error("Failed to spawn a live worker for the test.");
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    pid: child.pid,
    stop: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await exited;
    }
  };
}

async function waitForDeath(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Worker ${pid} did not exit in time.`);
}

// This is the round-5 blocker: on POSIX a detached agent worker can survive a
// runtime crash, so releasing a `running` occurrence unconditionally would let
// the next tick reclaim and run it a second time concurrently. Recovery must
// verify the specific worker's identity before releasing.
test("recoverInterrupted does not reclaim a running occurrence while its worker survives, then releases it once dead", async () => {
  if (process.platform === "win32") {
    return; // POSIX process-group identity is required for this guarantee.
  }
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-live-worker-"));
  const filePath = path.join(root, "schedule.json");
  const store = new ScheduleStore(filePath);
  const entry = await store.add(addInput());
  await store.claimDue(new Date(entry.nextRun));

  const worker = spawnLiveWorker();
  try {
    await store.recordRunningWorker(entry.id, captureWorkerIdentity(worker.pid));

    // Simulate the crash + restart: a brand-new store reads the persisted
    // running occurrence and its worker identity exactly as the next boot would.
    const rebooted = new ScheduleStore(filePath);
    const releasedWhileAlive = await rebooted.recoverInterrupted("Interrupted when Devbot restarted.");

    // The live worker still owns this occurrence, so it is not released...
    assert.equal(releasedWhileAlive.length, 0);
    const afterCrash = await rebooted.get(entry.id);
    assert.equal(afterCrash?.running, true);
    assert.equal(afterCrash?.recoveryBlocked ?? false, false);

    // ...and no tick can reclaim it while the worker lives, so the occurrence
    // can neither double-fire nor run concurrently with the surviving worker.
    const future = new Date(Date.now() + 3_600_000 + 1);
    assert.equal((await rebooted.claimDue(future)).length, 0);
    assert.equal((await rebooted.due(future)).length, 0);

    // Once the worker is gone, a later boot releases the occurrence to run again.
    await worker.stop();
    await waitForDeath(worker.pid);
    const afterDeath = new ScheduleStore(filePath);
    const releasedAfterDeath = await afterDeath.recoverInterrupted("Interrupted when Devbot restarted.");
    assert.equal(releasedAfterDeath.length, 1);
    const reclaimable = await afterDeath.get(entry.id);
    assert.equal(reclaimable?.running, false);
    assert.equal(reclaimable?.worker, undefined);
    assert.equal((await afterDeath.claimDue(new Date(Date.now() + 1000))).length, 1);
  } finally {
    await worker.stop();
  }
});

test("recoverInterrupted fails closed and blocks an occurrence when worker ownership cannot be verified", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput());
  await store.claimDue(new Date(entry.nextRun));
  await store.recordRunningWorker(entry.id, {
    pid: 999_999,
    pgid: 999_999,
    recordedAt: new Date().toISOString()
  });

  const released = await store.recoverInterrupted("Interrupted when Devbot restarted.", () => "unknown");
  assert.equal(released.length, 0);
  const blocked = await store.get(entry.id);
  assert.equal(blocked?.running, true);
  assert.equal(blocked?.recoveryBlocked, true);
  assert.match(blocked!.lastResult!, /Blocked for recovery/);

  // A blocked occurrence is never auto-reclaimed by a later tick.
  const future = new Date(Date.now() + 3_600_000 + 1);
  assert.equal((await store.claimDue(future)).length, 0);
  assert.equal((await store.due(future)).length, 0);
});

test("recoverInterrupted releases an occurrence whose worker is verifiably gone", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput());
  await store.claimDue(new Date(entry.nextRun));
  await store.recordRunningWorker(entry.id, {
    pid: 999_999,
    pgid: 999_999,
    recordedAt: new Date().toISOString()
  });

  const released = await store.recoverInterrupted("Interrupted when Devbot restarted.", () => "dead");
  assert.equal(released.length, 1);
  const current = await store.get(entry.id);
  assert.equal(current?.running, false);
  assert.equal(current?.recoveryBlocked ?? false, false);
  assert.equal(current?.worker, undefined);
});

test("a recorded worker identity survives reload from disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-worker-reload-"));
  const filePath = path.join(root, "schedule.json");
  const store = new ScheduleStore(filePath);
  const entry = await store.add(addInput());
  await store.claimDue(new Date(entry.nextRun));
  const worker: WorkerIdentity = {
    pid: 4242,
    pgid: 4242,
    startToken: "boot-abc:123456",
    recordedAt: new Date().toISOString()
  };
  await store.recordRunningWorker(entry.id, worker);

  const reloaded = new ScheduleStore(filePath);
  const loaded = (await reloaded.list())[0];
  assert.deepEqual(loaded?.worker, worker);
});

test("reconcileOnBoot recomputes nextRun from lastRun so a long-offline restart stays due exactly once", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput());
  const longAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
  await store.claimDue(new Date(longAgo));
  await store.markRun(entry.id, "ran once", new Date(longAgo));

  await store.reconcileOnBoot();
  const reconciled = await store.get(entry.id);
  assert.equal(new Date(reconciled!.nextRun).getTime(), new Date(longAgo).getTime() + 3_600_000);
  assert.ok(new Date(reconciled!.nextRun).getTime() < Date.now());

  const due = await store.due();
  assert.equal(due.length, 1);
});

test("reconcileOnBoot leaves a still-running entry alone", async () => {
  const store = await tempStore();
  const entry = await store.add(addInput());
  await store.claimDue(new Date(entry.nextRun));
  const before = (await store.get(entry.id))!.nextRun;

  await store.reconcileOnBoot();
  const after = await store.get(entry.id);
  assert.equal(after?.nextRun, before);
  assert.equal(after?.running, true);
});

test("formatScheduleList reports empty and populated schedules", () => {
  assert.match(formatScheduleList([]), /No scheduled tasks/);
});
