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
  isSentinelFastCommandEligible,
  isSentinelMutationSubcommand,
  resolveWatchTargets,
  SentinelManager,
  sentinelScreenshotAllowed,
  userAuthorizedForProjectPolicy,
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

test("isSentinelFastCommandEligible requires the command to be configured and read-only", () => {
  const configured = fakeProject();
  assert.equal(isSentinelFastCommandEligible(configured, "test"), true, "a configured read-only command is eligible");
  assert.equal(isSentinelFastCommandEligible(configured, "TEST"), true, "eligibility is case-insensitive");
  assert.equal(isSentinelFastCommandEligible(configured, "deploy"), false, "an unconfigured command is not eligible");

  const approvalRequired = fakeProject();
  approvalRequired.metadata.policy.approvalRequiredCommands = ["test"];
  assert.equal(
    isSentinelFastCommandEligible(approvalRequired, "test"),
    false,
    "a command reclassified as approval-required is no longer eligible"
  );

  const noLongerReadOnly = fakeProject();
  noLongerReadOnly.metadata.policy.readOnlyCommands = [];
  assert.equal(
    isSentinelFastCommandEligible(noLongerReadOnly, "test"),
    false,
    "a command dropped from readOnlyCommands is no longer eligible"
  );
});

test("resolveWatchTargets drops a persisted fast command once policy reclassifies it (policy drift)", () => {
  const config: SentinelProjectConfig = { enabled: true, intervalSeconds: 60, manualPaths: [], fastCommand: "test" };

  const eligible = fakeProject();
  const withCommand = resolveWatchTargets(eligible, config, ["http://127.0.0.1:3000/"]);
  assert.ok(
    withCommand.some((target) => target.kind === "command"),
    "a still-eligible fast command is materialized as a target"
  );

  const drifted = fakeProject();
  drifted.metadata.policy.approvalRequiredCommands = ["test"];
  const afterDrift = resolveWatchTargets(drifted, config, ["http://127.0.0.1:3000/"]);
  assert.ok(
    !afterDrift.some((target) => target.kind === "command"),
    "a fast command that policy now requires approval for must not run unattended, even though it is still persisted"
  );
});

test("isSentinelMutationSubcommand gates every configuration change but not read-only status", () => {
  for (const sub of ["on", "off", "interval", "watch", "fast-command", "expected-status"]) {
    assert.equal(isSentinelMutationSubcommand(sub), true, `${sub} must be controller-only`);
  }
  assert.equal(isSentinelMutationSubcommand("status"), false, "status is read-only and stays viewable");
});

test("a viewer can read status but no configuration subcommand runs unattended", () => {
  // The dispatcher requires a controller for every mutating subcommand and only
  // exempts read-only status, so a plain viewer reaches status and nothing else.
  assert.equal(isSentinelMutationSubcommand("status"), false, "a viewer can read status");
  for (const sub of ["on", "off", "interval", "watch", "fast-command", "expected-status"]) {
    assert.equal(isSentinelMutationSubcommand(sub), true, `a viewer cannot run ${sub}`);
  }
});

test("project-policy removal mid-schedule de-authorizes the enabling controller", () => {
  const policy = fakeProject().metadata.policy;

  // Open project: any enabling actor is authorized.
  assert.equal(userAuthorizedForProjectPolicy("controller-1", policy), true, "an open project authorizes any actor");

  // Controller is explicitly allow-listed by id.
  policy.allowedUsers = ["controller-1", "controller-2"];
  assert.equal(userAuthorizedForProjectPolicy("controller-1", policy), true, "an allow-listed controller is authorized");

  // The controller is removed from the project's allowlist mid-schedule: fail closed.
  policy.allowedUsers = ["controller-2"];
  assert.equal(
    userAuthorizedForProjectPolicy("controller-1", policy),
    false,
    "a controller removed from the project allowlist can no longer run its cycles"
  );

  // Role/username-only grants cannot be resolved for a background cycle: fail closed.
  policy.allowedUsers = [];
  policy.allowedUsernames = ["controller-name"];
  policy.allowedRoles = ["role-1"];
  assert.equal(
    userAuthorizedForProjectPolicy("controller-1", policy),
    false,
    "a role/username-only grant does not authorize an unattended, actor-by-id cycle"
  );
});

test("/sentinel on enable-time gate rejects a role/username-only grant that no cycle could satisfy", () => {
  // handleSentinelCommand's `on` branch enables only when
  // userAuthorizedForProjectPolicy(actorId, policy) holds — the same predicate
  // every unattended cycle authorizes against. A project that grants this actor
  // solely by role or username (never by allowedUsers) is rejected at enable
  // time, so `/sentinel on` cannot report success when every cycle must fail.
  const roleOnly = fakeProject().metadata.policy;
  roleOnly.allowedUsers = [];
  roleOnly.allowedUsernames = ["controller-name"];
  roleOnly.allowedRoles = ["role-1"];
  assert.equal(
    userAuthorizedForProjectPolicy("controller-1", roleOnly),
    false,
    "a role/username-only grant is rejected at enable time"
  );

  const byId = fakeProject().metadata.policy;
  byId.allowedUsers = ["controller-1"];
  assert.equal(userAuthorizedForProjectPolicy("controller-1", byId), true, "an explicit allowedUsers grant enables");

  const open = fakeProject().metadata.policy;
  assert.equal(userAuthorizedForProjectPolicy("controller-1", open), true, "an open project enables");
});

test("SentinelManager.runCycle stops when project policy removes the enabling controller", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-policy-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));
  const project = fakeProject();
  project.metadata.policy.allowedUsers = ["controller-1"];
  await store.setEnabled(project.name, true, "controller-1");

  let urlChecks = 0;
  const manager = new SentinelManager(
    () => [project],
    store,
    {
      discoverUrls: async () => ["http://127.0.0.1:4000"],
      checkUrlFn: async () => {
        urlChecks += 1;
        return ok();
      },
      checkCommandFn: async () => ok(),
      now: () => new Date(),
      authorizeCycle: (candidate, watchConfig) =>
        Boolean(watchConfig.enabledBy) &&
        userAuthorizedForProjectPolicy(watchConfig.enabledBy as string, candidate.metadata.policy)
    },
    async () => undefined
  );

  await manager.runCycle(project.name);
  const authorizedChecks = urlChecks;
  assert.ok(authorizedChecks > 0, "checks run while the enabling controller is authorized");

  // Remove the enabling controller from the project's current .devbot policy.
  project.metadata.policy.allowedUsers = ["controller-2"];
  await manager.runCycle(project.name);
  assert.equal(urlChecks, authorizedChecks, "no check runs once the enabling controller is dropped from the project policy");
});

test("sentinelScreenshotAllowed captures only under an allow policy, never deny or approval", () => {
  const allowed = fakeProject();
  assert.equal(sentinelScreenshotAllowed(allowed), true);

  const denied = fakeProject();
  denied.metadata.policy.screenshotPolicy = "deny";
  assert.equal(sentinelScreenshotAllowed(denied), false, "a deny policy suppresses the unattended capture");

  const approval = fakeProject();
  approval.metadata.policy.screenshotPolicy = "approval";
  assert.equal(
    sentinelScreenshotAllowed(approval),
    false,
    "an approval policy has no actor to approve an unattended capture, so it is suppressed"
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
    () => [project],
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
    () => [project],
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
    () => [project],
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
    () => [project],
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

test("SentinelManager.runCycle skips every check when the cycle is no longer authorized", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-authz-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));
  const project = fakeProject();
  await store.setEnabled(project.name, true, "controller-1");

  let urlChecks = 0;
  let commandChecks = 0;
  let authorized = true;
  const events: string[] = [];
  const manager = new SentinelManager(
    () => [project],
    store,
    {
      discoverUrls: async () => ["http://127.0.0.1:4000"],
      checkUrlFn: async () => {
        urlChecks += 1;
        return bad(500);
      },
      checkCommandFn: async () => {
        commandChecks += 1;
        return bad(500);
      },
      now: () => new Date(),
      authorizeCycle: (_project, watchConfig) => {
        assert.equal(watchConfig.enabledBy, "controller-1", "the enabling actor is revalidated each cycle");
        return authorized;
      }
    },
    async (event) => {
      events.push(event.event);
    }
  );

  await manager.runCycle(project.name);
  await manager.runCycle(project.name);
  const authorizedUrlChecks = urlChecks;

  authorized = false;
  await manager.runCycle(project.name);
  await manager.runCycle(project.name);

  assert.ok(authorizedUrlChecks > 0, "checks run while authorized");
  assert.equal(urlChecks, authorizedUrlChecks, "no URL fetch runs once the actor is de-authorized");
  assert.equal(commandChecks, 0, "no command runs once the actor is de-authorized");
  manager.stopAll();
});

test("SentinelManager.runCycle re-roots a same-name project mid-schedule and never runs against the stale root", async () => {
  // Bernard's reproduction: a same-name project changes root from /old/repo to
  // /new/repo while the watcher is scheduled. The manager must resolve the live
  // project every cycle so discovery, authorization, and execution all run
  // against the new root — never the object captured when it was first scheduled.
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-reroot-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));

  const oldProject = fakeProject();
  oldProject.root = "/old/repo";
  const newProject = fakeProject();
  newProject.root = "/new/repo";

  // The live config list, exactly as index.ts's `() => config.projects` reads it;
  // a runtime `/setup` change replaces the array with a freshly-loaded entry.
  let live: ProjectEntry[] = [oldProject];
  await store.setEnabled("demo", true, "controller-1");
  await store.setFastCommand("demo", "test");

  const discoveredRoots: string[] = [];
  const commandRoots: string[] = [];
  const authorizedRoots: string[] = [];
  const manager = new SentinelManager(
    () => live,
    store,
    {
      discoverUrls: async (project) => {
        discoveredRoots.push(project.root);
        return ["http://127.0.0.1:4000"];
      },
      checkUrlFn: async () => ok(),
      checkCommandFn: async (project) => {
        commandRoots.push(project.root);
        return ok();
      },
      now: () => new Date(),
      authorizeCycle: (project) => {
        authorizedRoots.push(project.root);
        // Authorization must receive the same freshly-resolved object as discovery/execution.
        assert.equal(project.root, live[0]!.root, "authorization runs against the live project object");
        return true;
      }
    },
    async () => undefined
  );

  await manager.runCycle("demo");
  assert.deepEqual(discoveredRoots, ["/old/repo"], "the first cycle discovers against the original root");
  assert.deepEqual(commandRoots, ["/old/repo"], "the first cycle executes against the original root");

  // Runtime setup re-roots the same-name project mid-schedule.
  live = [newProject];
  await manager.runCycle("demo");
  assert.deepEqual(discoveredRoots, ["/old/repo", "/new/repo"], "the next cycle discovers against the NEW root");
  assert.deepEqual(commandRoots, ["/old/repo", "/new/repo"], "the next cycle executes against the NEW root");
  assert.deepEqual(authorizedRoots, ["/old/repo", "/new/repo"], "authorization tracked the re-root in lockstep");
  assert.ok(!discoveredRoots.slice(1).includes("/old/repo"), "the stale root is never discovered again after re-rooting");
  assert.ok(!commandRoots.slice(1).includes("/old/repo"), "the stale root is never executed against after re-rooting");
  manager.stopAll();
});

test("SentinelManager.runCycle refuses a cycle once the project is removed from live config (remove race)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-remove-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));
  const project = fakeProject();
  let live: ProjectEntry[] = [project];
  await store.setEnabled(project.name, true, "controller-1");

  let urlChecks = 0;
  const manager = new SentinelManager(
    () => live,
    store,
    {
      discoverUrls: async () => ["http://127.0.0.1:4000"],
      checkUrlFn: async () => {
        urlChecks += 1;
        return ok();
      },
      checkCommandFn: async () => ok(),
      now: () => new Date(),
      authorizeCycle: () => true
    },
    async () => undefined
  );

  await manager.runCycle(project.name);
  const checksWhilePresent = urlChecks;
  assert.ok(checksWhilePresent > 0, "checks run while the project exists in live config");

  // A runtime setup change removes the project entirely.
  live = [];
  await manager.runCycle(project.name);
  assert.equal(urlChecks, checksWhilePresent, "a removed project runs no checks — the cycle is refused, not run against a stale object");
  manager.stopAll();
});

test("SentinelManager.startEnabled schedules from the live project list, not a captured one (add race)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-add-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));
  const added = fakeProject();
  added.root = "/added/repo";
  // The project is absent when the manager is constructed and only added later,
  // exactly as a runtime `/setup repo` add mutates `config.projects`.
  let live: ProjectEntry[] = [];
  await store.setEnabled(added.name, true, "controller-1");

  const discoveredRoots: string[] = [];
  const manager = new SentinelManager(
    () => live,
    store,
    {
      discoverUrls: async (project) => {
        discoveredRoots.push(project.root);
        return ["http://127.0.0.1:4000"];
      },
      checkUrlFn: async () => ok(),
      checkCommandFn: async () => ok(),
      now: () => new Date(),
      authorizeCycle: () => true
    },
    async () => undefined
  );

  // A cycle before the project is added is refused (nothing to resolve).
  await manager.runCycle(added.name);
  assert.deepEqual(discoveredRoots, [], "a cycle for an as-yet-unadded project is refused");

  // The project is added to live config, then a cycle resolves it fresh.
  live = [added];
  await manager.runCycle(added.name);
  assert.deepEqual(discoveredRoots, ["/added/repo"], "once added, the cycle discovers against the newly-added project's root");
  manager.stopAll();
});

test("checkUrl discards the response body so repeated polls cannot leak connections", async () => {
  let cancelled = 0;
  let redirectCancelled = 0;
  const url = "http://127.0.0.1:3000";
  const allowedOrigins = new Set([url]);

  const finalOnly: typeof fetch = (async () =>
    ({
      status: 200,
      headers: new Headers(),
      body: {
        cancel: async () => {
          cancelled += 1;
        }
      }
    }) as unknown as Response) as unknown as typeof fetch;

  const result = await checkUrl(url, allowedOrigins, { fetchImpl: finalOnly });
  assert.equal(result.ok, true);
  assert.equal(cancelled, 1, "the final response body is cancelled exactly once");

  let hop = 0;
  const withRedirect: typeof fetch = (async () => {
    hop += 1;
    if (hop === 1) {
      return {
        status: 302,
        headers: new Headers({ location: `${url}/next` }),
        body: {
          cancel: async () => {
            redirectCancelled += 1;
          }
        }
      } as unknown as Response;
    }
    return {
      status: 200,
      headers: new Headers(),
      body: {
        cancel: async () => {
          redirectCancelled += 1;
        }
      }
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const redirected = await checkUrl(url, allowedOrigins, { fetchImpl: withRedirect });
  assert.equal(redirected.ok, true);
  assert.equal(redirectCancelled, 2, "the redirect hop's body is drained as well as the final response's");
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
        readOnlyCommands: ["test"],
        approvalRequiredCommands: []
      }
    }
  };
}
