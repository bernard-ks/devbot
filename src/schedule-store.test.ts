import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeScheduleSpec,
  formatScheduleList,
  nextRunAfter,
  parseScheduleSpec,
  ScheduleStore,
  type ScheduleSpec
} from "./schedule-store.js";

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

test("schedule add computes a future nextRun and rejects a bad spec", async () => {
  const store = await tempStore();
  const entry = await store.add({ spec: "daily 07:00", project: "web", taskText: "standup digest", mode: "answer", addedBy: "tom" });
  assert.ok(new Date(entry.nextRun).getTime() > Date.now() - 1000);
  assert.equal(entry.enabled, true);
  await assert.rejects(() => store.add({ spec: "hourly", project: "web", taskText: "x", mode: "answer", addedBy: "tom" }), /Unrecognized schedule spec/);
});

test("schedule survives reload from disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-schedule-reload-"));
  const filePath = path.join(root, "schedule.json");
  const store = new ScheduleStore(filePath);
  await store.add({ spec: "every 2h", project: "web", taskText: "lint sweep", mode: "action", addedBy: "tom" });

  const reloaded = new ScheduleStore(filePath);
  const entries = await reloaded.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.taskText, "lint sweep");
});

test("pause disables an entry and resume recomputes nextRun from now", async () => {
  const store = await tempStore();
  const entry = await store.add({ spec: "every 1h", project: "web", taskText: "x", mode: "answer", addedBy: "tom" });
  const paused = await store.setEnabled(entry.id, false);
  assert.equal(paused?.enabled, false);

  const before = Date.now();
  const resumed = await store.setEnabled(entry.id, true);
  assert.equal(resumed?.enabled, true);
  assert.ok(new Date(resumed!.nextRun).getTime() >= before);
});

test("remove deletes the entry", async () => {
  const store = await tempStore();
  const entry = await store.add({ spec: "daily 07:00", project: "web", taskText: "x", mode: "answer", addedBy: "tom" });
  assert.equal(await store.remove(entry.id), true);
  assert.equal(await store.get(entry.id), undefined);
  assert.equal(await store.remove(entry.id), false);
});

test("due returns only enabled entries whose nextRun has passed", async () => {
  const store = await tempStore();
  const soon = await store.add({ spec: "every 1h", project: "web", taskText: "soon", mode: "answer", addedBy: "tom" });
  const far = await store.add({ spec: "every 1h", project: "web", taskText: "far", mode: "answer", addedBy: "tom" });
  const now = new Date();
  const due = await store.due(new Date(now.getTime() + 2 * 3_600_000 + 1));
  const dueIds = due.map((entry) => entry.id);
  assert.ok(dueIds.includes(soon.id));
  assert.ok(dueIds.includes(far.id));
  assert.equal((await store.due(now)).length, 0);
});

test("markRun records lastRun/lastResult and advances nextRun", async () => {
  const store = await tempStore();
  const entry = await store.add({ spec: "every 1h", project: "web", taskText: "x", mode: "answer", addedBy: "tom" });
  const runAt = new Date(entry.nextRun);
  await store.markRun(entry.id, "Posted an update.", runAt);
  const updated = await store.get(entry.id);
  assert.equal(updated?.lastRun, runAt.toISOString());
  assert.equal(updated?.lastResult, "Posted an update.");
  assert.equal(new Date(updated!.nextRun).getTime(), runAt.getTime() + 3_600_000);
});

test("reconcileOnBoot recomputes nextRun from lastRun so a long-offline restart stays due exactly once", async () => {
  const store = await tempStore();
  const entry = await store.add({ spec: "every 1h", project: "web", taskText: "x", mode: "answer", addedBy: "tom" });
  const longAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
  await store.markRun(entry.id, "ran once", new Date(longAgo));

  await store.reconcileOnBoot();
  const reconciled = await store.get(entry.id);
  assert.equal(new Date(reconciled!.nextRun).getTime(), new Date(longAgo).getTime() + 3_600_000);
  assert.ok(new Date(reconciled!.nextRun).getTime() < Date.now());

  const due = await store.due();
  assert.equal(due.length, 1);
});

test("formatScheduleList reports empty and populated schedules", () => {
  assert.match(formatScheduleList([]), /No scheduled tasks/);
});
