import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyWatchCheck,
  checkCommand,
  checkUrl,
  initialWatchState,
  resolveWatchTargets,
  SentinelManager,
  watchIdForCommand,
  watchIdForUrl,
  type WatchCheckResult,
  type WatchTarget
} from "./sentinel.js";
import { SentinelStore, type SentinelProjectConfig, type WatchState } from "./sentinel-store.js";
import type { ProjectCommandResult } from "./command-runner.js";
import type { ProjectEntry } from "./types.js";

test("a healthy watch stays up and never alerts", () => {
  const target: WatchTarget = { id: watchIdForUrl("http://127.0.0.1:1"), kind: "url", target: "http://127.0.0.1:1" };
  const first = applyWatchCheck(initialWatchState(target), ok(), "2026-01-01T00:00:00.000Z");
  assert.equal(first.state.status, "up");
  assert.equal(first.event, undefined);

  const second = applyWatchCheck(first.state, ok(), "2026-01-01T00:01:00.000Z");
  assert.equal(second.state.status, "up");
  assert.equal(second.event, undefined);
});

test("two consecutive bad responses debounce into exactly one down alert", () => {
  const target: WatchTarget = { id: "url-a", kind: "url", target: "http://127.0.0.1:1" };
  let state = initialWatchState(target);

  state = applyWatchCheck(state, ok(), "t0").state;
  const firstBad = applyWatchCheck(state, bad(500), "t1");
  assert.equal(firstBad.state.status, "up", "one bad response alone must not alert yet");
  assert.equal(firstBad.event, undefined);

  const secondBad = applyWatchCheck(firstBad.state, bad(500), "t2");
  assert.equal(secondBad.state.status, "down");
  assert.equal(secondBad.event, "alert");

  const thirdBad = applyWatchCheck(secondBad.state, bad(500), "t3");
  assert.equal(thirdBad.state.status, "down");
  assert.equal(thirdBad.event, undefined, "a third failure while already down must not re-alert (no spam)");

  const recovered = applyWatchCheck(thirdBad.state, ok(), "t4");
  assert.equal(recovered.state.status, "up");
  assert.equal(recovered.event, "recovery");
});

test("a full flap cycle produces exactly one alert and one recovery", () => {
  const target: WatchTarget = { id: "url-b", kind: "url", target: "http://127.0.0.1:1" };
  const sequence: WatchCheckResult[] = [ok(), bad(502), bad(502), bad(502), bad(502), ok(), ok()];
  let state = initialWatchState(target);
  const events: Array<"alert" | "recovery"> = [];
  let now = 0;
  for (const result of sequence) {
    const transition = applyWatchCheck(state, result, `t${now++}`);
    state = transition.state;
    if (transition.event) {
      events.push(transition.event);
    }
  }
  assert.deepEqual(events, ["alert", "recovery"]);
});

test("network refusal after being up transitions to idle, not down, and never alerts", () => {
  const target: WatchTarget = { id: "url-c", kind: "url", target: "http://127.0.0.1:1" };
  let state = applyWatchCheck(initialWatchState(target), ok(), "t0").state;
  assert.equal(state.status, "up");

  const stopped = applyWatchCheck(state, refused(), "t1");
  assert.equal(stopped.state.status, "idle");
  assert.equal(stopped.event, undefined);

  const stillStopped = applyWatchCheck(stopped.state, refused(), "t2");
  assert.equal(stillStopped.state.status, "idle");
  assert.equal(stillStopped.event, undefined, "repeated refusals while idle must not spam an alert");
});

test("a watch that has never been up goes straight to idle on refusal", () => {
  const target: WatchTarget = { id: "url-d", kind: "url", target: "http://127.0.0.1:1" };
  const result = applyWatchCheck(initialWatchState(target), refused(), "t0");
  assert.equal(result.state.status, "idle");
  assert.equal(result.event, undefined);
});

test("checkUrl reports ok for a reachable server and unreachable once it stops", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  const up = await checkUrl(url, 2_000);
  assert.equal(up.reachable, true);
  assert.equal(up.ok, true);
  assert.equal(up.statusCode, 200);

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  const down = await checkUrl(url, 1_000);
  assert.equal(down.reachable, false);
  assert.equal(down.ok, false);
});

test("checkUrl reports reachable-but-not-ok for server errors", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await checkUrl(`http://127.0.0.1:${port}`, 2_000);
    assert.equal(result.reachable, true);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("checkCommand maps a configured project command result into a watch check", async () => {
  const project = fakeProject();
  const passing = await checkCommand(project, "test", 1_000, async () => passingResult());
  assert.deepEqual(passing, { reachable: true, ok: true, exitCode: 0 });

  const failing = await checkCommand(project, "test", 1_000, async () => failingResult());
  assert.equal(failing.reachable, true);
  assert.equal(failing.ok, false);
  assert.equal(failing.exitCode, 1);
  assert.match(failing.error ?? "", /assertion failed/);
});

test("resolveWatchTargets combines discovered urls, manual paths, and a fast command", async () => {
  const project = fakeProject();
  const config: SentinelProjectConfig = { enabled: true, intervalSeconds: 60, manualPaths: ["/admin", "http://127.0.0.1:9/status"], fastCommand: "test" };
  const targets = await resolveWatchTargets(project, config, async () => ["http://127.0.0.1:3000/"]);

  const urlTargets = targets.filter((target) => target.kind === "url").map((target) => target.target);
  assert.ok(urlTargets.includes("http://127.0.0.1:3000"));
  assert.ok(urlTargets.includes("http://127.0.0.1:3000/admin"));
  assert.ok(urlTargets.includes("http://127.0.0.1:9/status"));

  const commandTarget = targets.find((target) => target.kind === "command");
  assert.equal(commandTarget?.target, "test");
  assert.equal(commandTarget?.id, watchIdForCommand("test"));
});

test("SentinelManager.runCycle debounces a flap into one alert and one recovery end to end", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));
  const project = fakeProject();
  await store.setEnabled(project.name, true);

  let tick = 0;
  const responses: WatchCheckResult[] = [ok(), bad(500), bad(500), ok()];
  const events: Array<"alert" | "recovery"> = [];

  const manager = new SentinelManager(
    [project],
    store,
    {
      discoverUrls: async () => ["http://127.0.0.1:4000"],
      checkUrlFn: async () => responses[Math.min(tick++, responses.length - 1)] ?? ok(),
      checkCommandFn: async () => ok(),
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick))
    },
    async (event) => {
      events.push(event.event);
    }
  );

  for (let i = 0; i < responses.length; i += 1) {
    await manager.runCycle(project.name);
  }

  assert.deepEqual(events, ["alert", "recovery"]);
  manager.stopAll();
});

test("SentinelManager suppresses alert delivery while a watch is muted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-mute-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));
  const project = fakeProject();
  await store.setEnabled(project.name, true);

  const watchId = watchIdForUrl("http://127.0.0.1:4000");
  const mutedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  await store.saveWatchState(project.name, watchId, {
    id: watchId,
    kind: "url",
    target: "http://127.0.0.1:4000",
    status: "up",
    consecutiveFailures: 0,
    mutedUntil
  });

  const events: string[] = [];
  const manager = new SentinelManager(
    [project],
    store,
    {
      discoverUrls: async () => ["http://127.0.0.1:4000"],
      checkUrlFn: async () => bad(500),
      checkCommandFn: async () => ok(),
      now: () => new Date()
    },
    async (event) => {
      events.push(event.event);
    }
  );

  await manager.runCycle(project.name);
  await manager.runCycle(project.name);
  assert.deepEqual(events, [], "a muted watch must not deliver an alert");

  const watch = await store.getWatchState(project.name, watchId);
  assert.equal(watch?.status, "down", "the underlying state still reflects reality while muted");
  manager.stopAll();
});

function ok(): WatchCheckResult {
  return { reachable: true, ok: true, statusCode: 200 };
}

function bad(statusCode: number): WatchCheckResult {
  return { reachable: true, ok: false, statusCode, error: `server responded ${statusCode}` };
}

function refused(): WatchCheckResult {
  return { reachable: false, ok: false, error: "ECONNREFUSED" };
}

function passingResult(): ProjectCommandResult {
  return {
    projectName: "demo",
    kind: "test",
    command: "npm test",
    ok: true,
    exitCode: 0,
    output: "all good",
    startedAt: "t0",
    finishedAt: "t1"
  };
}

function failingResult(): ProjectCommandResult {
  return {
    projectName: "demo",
    kind: "test",
    command: "npm test",
    ok: false,
    exitCode: 1,
    output: "assertion failed",
    startedAt: "t0",
    finishedAt: "t1"
  };
}

function fakeProject(): ProjectEntry {
  return {
    name: "demo",
    root: "/tmp/demo",
    metadata: {
      canonicalName: undefined,
      repoUrl: undefined,
      defaultBranch: "main",
      frontendUrl: undefined,
      backendUrl: undefined,
      ownerBot: undefined,
      aliases: [],
      commands: { test: ["npm test"], build: [], lint: [], verify: [], presets: {} },
      policy: {
        visibility: "private",
        allowedUsers: [],
        allowedUsernames: [],
        allowedRoles: [],
        allowedPeers: [],
        screenshotPolicy: "allow",
        maxContextChars: undefined,
        readOnlyCommands: [],
        approvalRequiredCommands: []
      }
    }
  };
}
