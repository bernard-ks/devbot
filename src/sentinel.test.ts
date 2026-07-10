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
import { defaultExpectedStatus, SentinelStore, type SentinelProjectConfig, type WatchState } from "./sentinel-store.js";
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

test("a network refusal after being up debounces into a down alert, same as a reachable error", () => {
  const target: WatchTarget = { id: "url-c", kind: "url", target: "http://127.0.0.1:1" };
  let state = applyWatchCheck(initialWatchState(target), ok(), "t0").state;
  assert.equal(state.status, "up");

  const firstRefusal = applyWatchCheck(state, refused(), "t1");
  assert.equal(firstRefusal.state.status, "up", "one refusal alone must not alert yet");
  assert.equal(firstRefusal.event, undefined);
  state = firstRefusal.state;

  const secondRefusal = applyWatchCheck(state, refused(), "t2");
  assert.equal(secondRefusal.state.status, "down", "a crashed dev server must not be silently treated as idle");
  assert.equal(secondRefusal.event, "alert");

  const stillRefused = applyWatchCheck(secondRefusal.state, refused(), "t3");
  assert.equal(stillRefused.state.status, "down");
  assert.equal(stillRefused.event, undefined, "repeated refusals while already down must not re-alert");
});

test("recovery fires once a target that crashed via refusal comes back up", () => {
  const target: WatchTarget = { id: "url-recover", kind: "url", target: "http://127.0.0.1:1" };
  let state = applyWatchCheck(initialWatchState(target), ok(), "t0").state;
  state = applyWatchCheck(state, refused(), "t1").state;
  const down = applyWatchCheck(state, refused(), "t2");
  assert.equal(down.state.status, "down");
  assert.equal(down.event, "alert");

  const recovered = applyWatchCheck(down.state, ok(), "t3");
  assert.equal(recovered.state.status, "up");
  assert.equal(recovered.event, "recovery");
});

test("a watch that has never been up goes straight to idle on refusal without alerting", () => {
  const target: WatchTarget = { id: "url-d", kind: "url", target: "http://127.0.0.1:1" };
  const result = applyWatchCheck(initialWatchState(target), refused(), "t0");
  assert.equal(result.state.status, "idle");
  assert.equal(result.event, undefined);

  const stillNeverUp = applyWatchCheck(result.state, refused(), "t1");
  assert.equal(stillNeverUp.state.status, "idle");
  assert.equal(stillNeverUp.event, undefined);
});

test("checkUrl reports ok for a reachable server and unreachable once it stops", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const allowedOrigins = new Set([new URL(url).origin]);

  const up = await checkUrl(url, allowedOrigins, { timeoutMs: 2_000 });
  assert.equal(up.reachable, true);
  assert.equal(up.ok, true);
  assert.equal(up.statusCode, 200);

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  const down = await checkUrl(url, allowedOrigins, { timeoutMs: 1_000 });
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
  const url = `http://127.0.0.1:${port}`;
  try {
    const result = await checkUrl(url, new Set([new URL(url).origin]), { timeoutMs: 2_000 });
    assert.equal(result.reachable, true);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("checkUrl treats 404 as a failure by default, but honors a configured expected-status option", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const allowedOrigins = new Set([new URL(url).origin]);
  try {
    const defaultResult = await checkUrl(url, allowedOrigins, { timeoutMs: 2_000 });
    assert.equal(defaultResult.statusCode, 404);
    assert.equal(defaultResult.ok, false, "a missing route must fail health by default, not pass like the old <500 rule");

    const configuredResult = await checkUrl(url, allowedOrigins, {
      timeoutMs: 2_000,
      isExpectedStatus: (status) => status === 404
    });
    assert.equal(configuredResult.ok, true, "an explicit expected-status option can accept 404 for projects that use it");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("checkUrl rejects a target whose origin is not in the approved set (SSRF hardening)", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("should never be reached");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  try {
    const result = await checkUrl(url, new Set(["http://127.0.0.1:9999"]), { timeoutMs: 2_000 });
    assert.equal(result.reachable, true);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /non-approved origin/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("checkUrl rejects a URL carrying embedded credentials even if the host is loopback and approved", async () => {
  const url = "http://admin:hunter2@127.0.0.1:9/status";
  const result = await checkUrl(url, new Set(["http://127.0.0.1:9"]), {
    timeoutMs: 1_000,
    fetchImpl: async () => {
      throw new Error("fetch must never be called for a credentialed URL");
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /non-approved origin/);
});

test("checkUrl follows a redirect to an approved origin and evaluates the final response", async () => {
  const target = createServer((_req, res) => {
    res.writeHead(200);
    res.end("final");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as AddressInfo).port;
  const targetUrl = `http://127.0.0.1:${targetPort}`;

  const gateway = createServer((_req, res) => {
    res.writeHead(302, { location: targetUrl });
    res.end();
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (gateway.address() as AddressInfo).port;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    const allowedOrigins = new Set([new URL(gatewayUrl).origin, new URL(targetUrl).origin]);
    const result = await checkUrl(gatewayUrl, allowedOrigins, { timeoutMs: 2_000 });
    assert.equal(result.reachable, true);
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve()))),
      new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())))
    ]);
  }
});

test("checkUrl blocks a redirect to an origin outside the approved set", async () => {
  const disallowed = createServer((_req, res) => {
    res.writeHead(200);
    res.end("should never be reached");
  });
  await new Promise<void>((resolve) => disallowed.listen(0, "127.0.0.1", resolve));
  const disallowedPort = (disallowed.address() as AddressInfo).port;
  const disallowedUrl = `http://127.0.0.1:${disallowedPort}`;

  const gateway = createServer((_req, res) => {
    res.writeHead(302, { location: disallowedUrl });
    res.end();
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (gateway.address() as AddressInfo).port;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    const allowedOrigins = new Set([new URL(gatewayUrl).origin]);
    const result = await checkUrl(gatewayUrl, allowedOrigins, { timeoutMs: 2_000 });
    assert.equal(result.reachable, true);
    assert.equal(result.ok, false, "a redirect off the approved origin set must fail rather than being followed");
    assert.match(result.error ?? "", /non-approved origin/);
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => disallowed.close((error) => (error ? reject(error) : resolve()))),
      new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())))
    ]);
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

test("resolveWatchTargets combines discovered urls, manual paths, and a fast command", () => {
  const project = fakeProject();
  const config: SentinelProjectConfig = { enabled: true, intervalSeconds: 60, manualPaths: ["/admin", "http://127.0.0.1:3000/status"], fastCommand: "test" };
  const targets = resolveWatchTargets(project, config, ["http://127.0.0.1:3000/"]);

  const urlTargets = targets.filter((target) => target.kind === "url").map((target) => target.target);
  assert.ok(urlTargets.includes("http://127.0.0.1:3000"));
  assert.ok(urlTargets.includes("http://127.0.0.1:3000/admin"));
  assert.ok(urlTargets.includes("http://127.0.0.1:3000/status"));

  const commandTarget = targets.find((target) => target.kind === "command");
  assert.equal(commandTarget?.target, "test");
  assert.equal(commandTarget?.id, watchIdForCommand("test"));
});

test("resolveWatchTargets drops a manual absolute URL whose origin is not among the project's approved origins", () => {
  const project = fakeProject();
  const config: SentinelProjectConfig = {
    enabled: true,
    intervalSeconds: 60,
    manualPaths: ["http://127.0.0.1:9999/unrelated-service"]
  };
  const targets = resolveWatchTargets(project, config, ["http://127.0.0.1:3000/"]);
  const urlTargets = targets.map((target) => target.target);
  assert.ok(
    !urlTargets.includes("http://127.0.0.1:9999/unrelated-service"),
    "a manual URL on a port the project never exposed must not become a poll target, even though it is loopback"
  );
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

test("SentinelManager.runCycle passes the project's approved origins and expected-status option through to checkUrlFn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-status-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));
  const project = fakeProject();
  await store.setEnabled(project.name, true);
  await store.setExpectedStatus(project.name, "404");

  let seenOrigins: ReadonlySet<string> | undefined;
  let seenIsExpectedStatus: ((status: number) => boolean) | undefined;
  const manager = new SentinelManager(
    [project],
    store,
    {
      discoverUrls: async () => ["http://127.0.0.1:4000"],
      checkUrlFn: async (_url, allowedOrigins, isExpectedStatus) => {
        seenOrigins = allowedOrigins;
        seenIsExpectedStatus = isExpectedStatus;
        return ok();
      },
      checkCommandFn: async () => ok(),
      now: () => new Date()
    },
    async () => {}
  );

  await manager.runCycle(project.name);
  assert.ok(seenOrigins?.has("http://127.0.0.1:4000"));
  assert.equal(seenIsExpectedStatus?.(404), true);
  assert.equal(seenIsExpectedStatus?.(200), false);
  assert.notEqual(seenIsExpectedStatus, defaultExpectedStatus);
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

test("SentinelManager.runCycle never overlaps checks for the same project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-overlap-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));
  const project = fakeProject();
  await store.setEnabled(project.name, true);

  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const manager = new SentinelManager(
    [project],
    store,
    {
      discoverUrls: async () => ["http://127.0.0.1:4000"],
      checkUrlFn: async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return ok();
      },
      checkCommandFn: async () => ok(),
      now: () => new Date()
    },
    async () => {}
  );

  await Promise.all([manager.runCycle(project.name), manager.runCycle(project.name)]);
  assert.equal(maxInFlight, 1, "a second concurrent runCycle call for the same project must not run checks in parallel");
  assert.equal(calls, 1, "the overlapping call must return early instead of re-running the check");
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
