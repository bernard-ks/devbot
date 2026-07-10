import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  clampTtlMinutes,
  describeProjectRevision,
  findCloudflaredPath,
  findRunningProjectOrigin,
  parseTunnelUrl,
  previewGateReason,
  previewOwnerGateReason,
  projectPreviewGateReason,
  startCloudflaredTunnel,
  TunnelManager,
  validateLoopbackOrigin,
  type ActiveTunnel,
  type PendingTunnel,
  type TunnelChildProcess,
  type TunnelExpireReason,
  type TunnelManagerDeps,
  type TunnelSpawnFn
} from "./tunnel.js";
import type { ProjectEntry } from "./types.js";

const execFileAsync = promisify(execFile);

test("parseTunnelUrl extracts the trycloudflare URL from mixed cloudflared output", () => {
  const line = "2026-07-09T00:00:00Z INF |  https://random-words-here.trycloudflare.com                                |";
  assert.equal(parseTunnelUrl(line), "https://random-words-here.trycloudflare.com");
  assert.equal(parseTunnelUrl("no url in this line"), undefined);
});

test("clampTtlMinutes applies default, max, and min bounds", () => {
  assert.equal(clampTtlMinutes(undefined), 15);
  assert.equal(clampTtlMinutes(5), 5);
  assert.equal(clampTtlMinutes(500), 60);
  assert.equal(clampTtlMinutes(0), 1);
  assert.equal(clampTtlMinutes(-10), 1);
  assert.equal(clampTtlMinutes(12.9), 12);
  assert.equal(clampTtlMinutes(Number.NaN), 15);
});

test("findCloudflaredPath scans PATH entries in order and returns the first executable match", () => {
  const pathEnv = ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"].join(":");
  const executable = new Set(["/opt/homebrew/bin/cloudflared"]);
  assert.equal(findCloudflaredPath(pathEnv, (candidate) => executable.has(candidate)), "/opt/homebrew/bin/cloudflared");
  assert.equal(findCloudflaredPath(pathEnv, () => false), undefined);
});

test("previewOwnerGateReason and previewGateReason report why /preview would be refused", () => {
  assert.equal(previewOwnerGateReason({ ownerUserId: undefined }, "user-1"), "no-owner");
  assert.equal(previewOwnerGateReason({ ownerUserId: "owner-1" }, "user-1"), "not-owner");
  assert.equal(previewOwnerGateReason({ ownerUserId: "owner-1" }, "owner-1"), undefined);

  assert.equal(previewGateReason({ previewTunnelsEnabled: true, ownerUserId: undefined }, "user-1"), "no-owner");
  assert.equal(previewGateReason({ previewTunnelsEnabled: true, ownerUserId: "owner-1" }, "user-1"), "not-owner");
  assert.equal(previewGateReason({ previewTunnelsEnabled: false, ownerUserId: "owner-1" }, "owner-1"), "disabled");
  assert.equal(previewGateReason({ previewTunnelsEnabled: true, ownerUserId: "owner-1" }, "owner-1"), undefined);
});

test("projectPreviewGateReason defaults to deny", () => {
  assert.equal(projectPreviewGateReason(false), "project-disabled");
  assert.equal(projectPreviewGateReason(true), undefined);
});

test("validateLoopbackOrigin preserves scheme and port, normalizes localhost/IPv6, and rejects remote or credentialed URLs", () => {
  assert.deepEqual(validateLoopbackOrigin("http://127.0.0.1:3000"), { origin: "http://127.0.0.1:3000", port: 3000 });
  assert.deepEqual(validateLoopbackOrigin("http://localhost:5173"), { origin: "http://127.0.0.1:5173", port: 5173 });
  assert.deepEqual(validateLoopbackOrigin("http://[::1]:8080"), { origin: "http://127.0.0.1:8080", port: 8080 });
  assert.deepEqual(validateLoopbackOrigin("https://127.0.0.1:8443"), { origin: "https://127.0.0.1:8443", port: 8443 });
  assert.deepEqual(validateLoopbackOrigin("https://127.0.0.1"), { origin: "https://127.0.0.1:443", port: 443 });
  assert.deepEqual(validateLoopbackOrigin("http://127.0.0.1"), { origin: "http://127.0.0.1:80", port: 80 });

  assert.equal(validateLoopbackOrigin("https://example.com/app"), undefined);
  assert.equal(validateLoopbackOrigin("http://attacker:pw@127.0.0.1:3000"), undefined);
  assert.equal(validateLoopbackOrigin("ftp://127.0.0.1:21"), undefined);
  assert.equal(validateLoopbackOrigin("not a url"), undefined);
});

test("findRunningProjectOrigin independently re-validates candidates, ignoring anything upstream missed", async () => {
  const project = fakeProject("web");
  const urls = ["https://example.com/app", "http://127.0.0.1:3000", "https://127.0.0.1:8443"];
  // A remote candidate that would answer "reachable" must still be rejected: the
  // manager must not trust upstream filtering (defense in depth).
  const reachable = new Set(["https://example.com/app", "https://127.0.0.1:8443"]);
  const probed: string[] = [];
  const origin = await findRunningProjectOrigin(
    project,
    async (candidate) => {
      probed.push(candidate);
      return reachable.has(candidate);
    },
    async () => urls
  );
  assert.deepEqual(origin, { origin: "https://127.0.0.1:8443", port: 8443 });
  assert.equal(probed.includes("https://example.com/app"), false);
});

test("findRunningProjectOrigin returns undefined when nothing validated is reachable", async () => {
  const project = fakeProject("web");
  const origin = await findRunningProjectOrigin(
    project,
    async () => false,
    async () => ["http://127.0.0.1:3000"]
  );
  assert.equal(origin, undefined);
});

test("describeProjectRevision reads branch and short revision from a real repo and falls back to unknown otherwise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-tunnel-git-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"]);
  const info = await describeProjectRevision(fakeProject("web", root));
  assert.equal(info.branch, "main");
  assert.match(info.revision, /^[0-9a-f]{4,}$/);

  const nonRepoRoot = await mkdtemp(path.join(tmpdir(), "devbot-tunnel-nogit-"));
  const fallback = await describeProjectRevision(fakeProject("web", nonRepoRoot));
  assert.equal(fallback.branch, "unknown");
  assert.equal(fallback.revision, "unknown");
});

test("startCloudflaredTunnel resolves with the parsed URL from stderr", async () => {
  const child = fakeChild();
  const spawnFn: TunnelSpawnFn = () => child;
  const promise = startCloudflaredTunnel({
    spawnFn,
    cloudflaredPath: "/usr/local/bin/cloudflared",
    origin: "http://127.0.0.1:3000",
    env: {},
    urlTimeoutMs: 1_000
  });
  child.emitStderr("some log line\n");
  child.emitStderr("https://cheerful-otters.trycloudflare.com\n");
  const result = await promise;
  assert.equal(result.url, "https://cheerful-otters.trycloudflare.com");
});

test("startCloudflaredTunnel rejects when cloudflared exits before reporting a URL", async () => {
  const child = fakeChild();
  const spawnFn: TunnelSpawnFn = () => child;
  const promise = startCloudflaredTunnel({ spawnFn, cloudflaredPath: "/usr/local/bin/cloudflared", origin: "http://127.0.0.1:3000", env: {}, urlTimeoutMs: 1_000 });
  child.emitExit(1);
  await assert.rejects(promise, /exited before reporting/);
});

test("startCloudflaredTunnel rejects and kills the child on timeout", async () => {
  const child = fakeChild();
  const spawnFn: TunnelSpawnFn = () => child;
  const promise = startCloudflaredTunnel({ spawnFn, cloudflaredPath: "/usr/local/bin/cloudflared", origin: "http://127.0.0.1:3000", env: {}, urlTimeoutMs: 5 });
  await assert.rejects(promise, /Timed out/);
  assert.equal(child.killed, true);
});

test("startCloudflaredTunnel rejects on a spawn error and swallows a later error without crashing", async () => {
  const child = fakeChild();
  const spawnFn: TunnelSpawnFn = () => child;
  const promise = startCloudflaredTunnel({ spawnFn, cloudflaredPath: "/usr/local/bin/cloudflared", origin: "http://127.0.0.1:3000", env: {}, urlTimeoutMs: 1_000 });
  child.emitError(new Error("spawn cloudflared ENOENT"));
  await assert.rejects(promise, /ENOENT/);
  // A second, later error event on the same child must not throw as an
  // unhandled EventEmitter error now that the promise has already settled.
  assert.doesNotThrow(() => child.emitError(new Error("late error")));
});

test("TunnelManager reserve claims the project slot synchronously, closing the race window before anything spawns", () => {
  const { manager } = makeManager();
  manager.reserve(reserveInput({ projectName: "web" }));
  assert.throws(() => manager.reserve(reserveInput({ projectName: "web" })), /already has an active or pending preview tunnel/);
});

test("TunnelManager reserve enforces a global concurrency limit across pending and active tunnels", () => {
  const { manager } = makeManager({ maxConcurrentTunnels: 1 });
  manager.reserve(reserveInput({ projectName: "web" }));
  assert.throws(() => manager.reserve(reserveInput({ projectName: "api" })), /already has 1 preview tunnel/);
});

test("TunnelManager launch spawns with an isolated HOME, no bot secrets, and the exact validated origin", async () => {
  const previousToken = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = "discord-bot-secret";
  try {
    const capturedArgs: string[][] = [];
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const spawnFn: TunnelSpawnFn = (_command, args, env) => {
      capturedArgs.push(args);
      capturedEnvs.push(env);
      return fakeChild();
    };
    const { manager } = makeManager({}, spawnFn);
    const pending = manager.reserve(reserveInput({ projectName: "web", origin: "https://127.0.0.1:8443" }));

    const tunnel = await launchAndReportUrl(manager, pending.id, () => {}, "https://web.trycloudflare.com");

    assert.equal(tunnel.url, "https://web.trycloudflare.com");
    assert.deepEqual(capturedArgs[0], ["tunnel", "--url", "https://127.0.0.1:8443"]);
    assert.equal(capturedEnvs[0]?.DISCORD_TOKEN, undefined);
    assert.notEqual(capturedEnvs[0]?.HOME, process.env.HOME);
    await assert.rejects(stat(capturedEnvs[0]?.HOME as string), /ENOENT/);
  } finally {
    if (previousToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = previousToken;
  }
});

test("TunnelManager launch removes the isolated home after the tunnel is later stopped", async () => {
  const { manager, homesRemoved } = makeManager();
  const pending = manager.reserve(reserveInput({ projectName: "web" }));
  const tunnel = await launchAndReportUrl(manager, pending.id, () => {}, "https://web.trycloudflare.com");
  await manager.stop(tunnel.id, "stop");
  assert.equal(homesRemoved.length, 1);
});

test("TunnelManager launch throws for an unknown or already-expired reservation", async () => {
  const { manager } = makeManager();
  await assert.rejects(manager.launch("does-not-exist", () => {}), /Run `\/preview share` again/);
});

test("TunnelManager launch aborts and cleans up when the reservation is cancelled while cloudflared is starting", async () => {
  const { manager, homesRemoved } = makeManager();
  const pending = manager.reserve(reserveInput({ projectName: "web" }));
  const launchPromise = manager.launch(pending.id, () => {});
  const spawnedChild = lastSpawnedChild;
  manager.cancelPending(pending.id);
  spawnedChild?.emitStdout("https://web.trycloudflare.com\n");
  await assert.rejects(launchPromise, /cancelled before it finished starting/);
  assert.equal(spawnedChild?.killed, true);
  assert.equal(homesRemoved.length, 1);
  assert.equal(manager.hasActiveForProject("web"), false);
});

test("TunnelManager cancelPending frees the project slot and reports the cancellation", () => {
  const { manager } = makeManager();
  let expired: { projectName: string; reason: string } | undefined;
  const pending = manager.reserve(
    reserveInput({ projectName: "web", onPendingExpire: (tunnel, reason) => { expired = { projectName: tunnel.projectName, reason }; } })
  );
  const cancelled = manager.cancelPending(pending.id);
  assert.equal(cancelled?.projectName, "web");
  assert.equal(expired?.reason, "cancel");
  assert.equal(manager.hasActiveForProject("web"), false);
  manager.reserve(reserveInput({ projectName: "web" }));
});

test("TunnelManager pending confirmation auto-expires and frees the project slot", async () => {
  const { manager } = makeManager({ pendingConfirmTimeoutMs: 10 });
  let expiredReason: string | undefined;
  manager.reserve(
    reserveInput({ projectName: "web", onPendingExpire: (_tunnel, reason) => { expiredReason = reason; } })
  );
  await sleep(40);
  assert.equal(expiredReason, "confirm-timeout");
  assert.equal(manager.hasActiveForProject("web"), false);
});

test("TunnelManager get/getPending report undefined for stale (unknown) ids", async () => {
  const { manager } = makeManager();
  const pending = manager.reserve(reserveInput({ projectName: "web" }));
  assert.ok(manager.getPending(pending.id));
  assert.equal(manager.get(pending.id), undefined);

  const tunnel = await launchAndReportUrl(manager, pending.id, () => {}, "https://web.trycloudflare.com");
  assert.ok(manager.get(tunnel.id));
  assert.equal(manager.getPending(tunnel.id), undefined);

  await manager.stop(tunnel.id, "stop");
  assert.equal(manager.get(tunnel.id), undefined);
});

test("TunnelManager stop kills the child with SIGTERM, waits for confirmed exit, and clears the TTL timer", async () => {
  const { manager } = makeManager();
  const pending = manager.reserve(reserveInput({ projectName: "web", ttlMinutes: 10 }));
  const tunnel = await launchAndReportUrl(manager, pending.id, () => {}, "https://web.trycloudflare.com");
  const child = lastSpawnedChild;

  const stopped = await manager.stop(tunnel.id, "stop");
  assert.equal(stopped?.url, "https://web.trycloudflare.com");
  assert.deepEqual(child?.killSignals, ["SIGTERM"]);
  assert.equal(manager.get(tunnel.id), undefined);
});

test("TunnelManager stop escalates to SIGKILL when cloudflared ignores SIGTERM", async () => {
  const spawnFn: TunnelSpawnFn = () => fakeChild({ killBehavior: "ignore-sigterm" });
  const { manager } = makeManager({ killGraceMs: 15 }, spawnFn);
  const pending = manager.reserve(reserveInput({ projectName: "web" }));
  const tunnel = await launchAndReportUrl(manager, pending.id, () => {}, "https://web.trycloudflare.com");
  const child = lastSpawnedChild;

  const stopped = await manager.stop(tunnel.id, "stop");
  assert.ok(stopped);
  assert.deepEqual(child?.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("TunnelManager stop gives up after SIGTERM and SIGKILL both go unanswered, without hanging forever", async () => {
  const spawnFn: TunnelSpawnFn = () => fakeChild({ killBehavior: "ignore-all" });
  const { manager } = makeManager({ killGraceMs: 10 }, spawnFn);
  const pending = manager.reserve(reserveInput({ projectName: "web" }));
  const tunnel = await launchAndReportUrl(manager, pending.id, () => {}, "https://web.trycloudflare.com");
  const child = lastSpawnedChild;

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    const stopped = await manager.stop(tunnel.id, "stop");
    assert.ok(stopped);
    assert.deepEqual(child?.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.ok(warnings.some((message) => message.includes("did not confirm exit")));
  } finally {
    console.warn = originalWarn;
  }
});

test("TunnelManager TTL expiry kills the child and invokes onExpire with reason ttl", async () => {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const spawnFn: TunnelSpawnFn = () => fakeChild();
  const { manager } = makeManager(
    {
      scheduleTimeout: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length - 1;
      },
      clearScheduledTimeout: () => {}
    },
    spawnFn
  );

  let expired: { reason: string } | undefined;
  const pending = manager.reserve(reserveInput({ projectName: "web", ttlMinutes: 7 }));
  await launchAndReportUrl(manager, pending.id, (_tunnel, reason) => { expired = { reason }; }, "https://web.trycloudflare.com");
  const child = lastSpawnedChild;

  const ttlSchedule = scheduled.find((entry) => entry.ms === 7 * 60_000);
  assert.ok(ttlSchedule);
  ttlSchedule?.fn();
  await sleep(0);

  assert.equal(manager.hasActiveForProject("web"), false);
  assert.equal(expired?.reason, "ttl");
  assert.equal(child?.killed, true);
});

test("TunnelManager unexpected process exit removes the tunnel and reports process-exit", async () => {
  const { manager } = makeManager();
  let expired: { reason: string } | undefined;
  const pending = manager.reserve(reserveInput({ projectName: "web" }));
  await launchAndReportUrl(manager, pending.id, (_tunnel, reason) => { expired = { reason }; }, "https://web.trycloudflare.com");
  const child = lastSpawnedChild;

  child?.emitExit(1);
  await sleep(0);
  assert.equal(manager.hasActiveForProject("web"), false);
  assert.equal(expired?.reason, "process-exit");
});

test("TunnelManager treats a post-startup child error the same as an unexpected exit, without crashing", async () => {
  const { manager } = makeManager();
  let expired: { reason: string } | undefined;
  const pending = manager.reserve(reserveInput({ projectName: "web" }));
  await launchAndReportUrl(manager, pending.id, (_tunnel, reason) => { expired = { reason }; }, "https://web.trycloudflare.com");
  const child = lastSpawnedChild;

  assert.doesNotThrow(() => child?.emitError(new Error("connection reset")));
  await sleep(0);
  assert.equal(expired?.reason, "process-exit");
});

test("TunnelManager stopByProject cancels a pending reservation or stops an active tunnel by project name", async () => {
  const { manager } = makeManager();

  const pendingOnly = manager.reserve(reserveInput({ projectName: "queued" }));
  const cancelledResult = await manager.stopByProject("queued", "stop");
  assert.equal(cancelledResult?.kind, "pending");
  assert.equal(cancelledResult?.tunnel.id, pendingOnly.id);

  const pending = manager.reserve(reserveInput({ projectName: "web" }));
  await launchAndReportUrl(manager, pending.id, () => {}, "https://web.trycloudflare.com");
  const activeResult = await manager.stopByProject("web", "stop");
  assert.equal(activeResult?.kind, "active");

  assert.equal(await manager.stopByProject("missing", "stop"), undefined);
});

test("TunnelManager stopAll cancels pending reservations and stops every active tunnel", async () => {
  const { manager } = makeManager();

  manager.reserve(reserveInput({ projectName: "queued" }));
  const first = manager.reserve(reserveInput({ projectName: "web" }));
  await launchAndReportUrl(manager, first.id, () => {}, "https://web.trycloudflare.com");

  const second = manager.reserve(reserveInput({ projectName: "api" }));
  await launchAndReportUrl(manager, second.id, () => {}, "https://api.trycloudflare.com");

  const stopped = await manager.stopAll("shutdown");
  assert.equal(stopped.length, 2);
  assert.equal(manager.list().length, 0);
  assert.equal(manager.hasActiveForProject("queued"), false);
});

let lastSpawnedChild: FakeChild | undefined;

interface FakeChildOptions {
  killBehavior?: "respond" | "ignore-sigterm" | "ignore-all";
}

type FakeChild = TunnelChildProcess & {
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitExit(code: number | null): void;
  emitError(error: Error): void;
  killSignals: NodeJS.Signals[];
  killed: boolean;
};

function fakeChild(options: FakeChildOptions = {}): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  const killBehavior = options.killBehavior ?? "respond";
  let exited = false;
  const killSignals: NodeJS.Signals[] = [];
  const child: FakeChild = {
    stdout,
    stderr,
    killed: false,
    killSignals,
    on: emitter.on.bind(emitter),
    kill(signal?: NodeJS.Signals) {
      const sig = signal ?? "SIGTERM";
      killSignals.push(sig);
      child.killed = true;
      const shouldExit = killBehavior === "respond" || (killBehavior === "ignore-sigterm" && sig === "SIGKILL");
      if (shouldExit && !exited) {
        exited = true;
        emitter.emit("exit", null, sig);
      }
      return true;
    },
    emitStdout(chunk: string) {
      stdout.emit("data", chunk);
    },
    emitStderr(chunk: string) {
      stderr.emit("data", chunk);
    },
    emitExit(code: number | null) {
      if (exited) return;
      exited = true;
      emitter.emit("exit", code, null);
    },
    emitError(error: Error) {
      emitter.emit("error", error);
    }
  };
  lastSpawnedChild = child;
  return child;
}

function makeManager(
  overrides: Partial<TunnelManagerDeps> = {},
  spawnFn?: TunnelSpawnFn
): { manager: TunnelManager; homesCreated: string[]; homesRemoved: string[] } {
  const homesCreated: string[] = [];
  const homesRemoved: string[] = [];
  const defaultSpawn: TunnelSpawnFn = () => fakeChild();
  const manager = new TunnelManager({
    spawnFn: spawnFn ?? defaultSpawn,
    findCloudflaredPath: () => "/usr/local/bin/cloudflared",
    urlTimeoutMs: 2_000,
    killGraceMs: 5_000,
    pendingConfirmTimeoutMs: 120_000,
    createTunnelHome: async () => {
      const dir = `/fake/tunnel-home/${homesCreated.length}`;
      homesCreated.push(dir);
      return dir;
    },
    removeTunnelHome: async (dir) => {
      homesRemoved.push(dir);
    },
    ...overrides
  });
  return { manager, homesCreated, homesRemoved };
}

function reserveInput(overrides: {
  projectName: string;
  origin?: string;
  ttlMinutes?: number;
  onPendingExpire?: (pending: PendingTunnel, reason: "confirm-timeout" | "cancel") => void;
}) {
  return {
    projectName: overrides.projectName,
    origin: overrides.origin ?? "http://127.0.0.1:3000",
    port: 3000,
    ...(overrides.ttlMinutes !== undefined ? { ttlMinutes: overrides.ttlMinutes } : {}),
    requestedBy: "owner-1",
    channelId: "chan-1",
    onPendingExpire: overrides.onPendingExpire ?? (() => {})
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `launch()` awaits an isolated-home creation step before it spawns, so the
 * child is not available on `lastSpawnedChild` in the same microtask turn as
 * the `launch()` call. Waiting a tick lets that spawn happen before emitting
 * the URL cloudflared would report on stdout.
 */
async function launchAndReportUrl(
  manager: TunnelManager,
  id: string,
  onExpire: (tunnel: ActiveTunnel, reason: TunnelExpireReason) => void,
  url: string
): Promise<ActiveTunnel> {
  const launchPromise = manager.launch(id, onExpire);
  await sleep(0);
  lastSpawnedChild?.emitStdout(`${url}\n`);
  return launchPromise;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function fakeProject(name: string, root?: string): ProjectEntry {
  return {
    name,
    root: root ?? `/tmp/${name}`,
    metadata: {
      canonicalName: undefined,
      repoUrl: undefined,
      defaultBranch: "main",
      frontendUrl: undefined,
      backendUrl: undefined,
      ownerBot: undefined,
      aliases: [],
      commands: { test: [], build: [], lint: [], verify: [], presets: {} },
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

