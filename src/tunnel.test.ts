import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  clampTtlMinutes,
  findCloudflaredPath,
  findRunningProjectPort,
  parseTunnelUrl,
  previewGateReason,
  startCloudflaredTunnel,
  TunnelManager,
  type TunnelChildProcess,
  type TunnelSpawnFn
} from "./tunnel.js";
import type { ProjectEntry } from "./types.js";

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

test("previewGateReason reports why /preview would be refused", () => {
  assert.equal(previewGateReason({ previewTunnelsEnabled: true, ownerUserId: undefined }, "user-1"), "no-owner");
  assert.equal(previewGateReason({ previewTunnelsEnabled: true, ownerUserId: "owner-1" }, "user-1"), "not-owner");
  assert.equal(previewGateReason({ previewTunnelsEnabled: false, ownerUserId: "owner-1" }, "owner-1"), "disabled");
  assert.equal(previewGateReason({ previewTunnelsEnabled: true, ownerUserId: "owner-1" }, "owner-1"), undefined);
});

test("findRunningProjectPort probes detected URLs and returns the first reachable port", async () => {
  const project = fakeProject("web");
  const urls = ["http://127.0.0.1:3000", "http://127.0.0.1:5173"];
  const reachable = new Set(["http://127.0.0.1:5173"]);
  const port = await findRunningProjectPort(
    project,
    async (url) => reachable.has(url),
    async () => urls
  );
  assert.equal(port, 5173);
});

test("findRunningProjectPort returns undefined when nothing is reachable", async () => {
  const project = fakeProject("web");
  const port = await findRunningProjectPort(
    project,
    async () => false,
    async () => ["http://127.0.0.1:3000"]
  );
  assert.equal(port, undefined);
});

test("startCloudflaredTunnel resolves with the parsed URL from stderr", async () => {
  const child = fakeChild();
  const spawnFn: TunnelSpawnFn = () => child;
  const promise = startCloudflaredTunnel({ spawnFn, cloudflaredPath: "/usr/local/bin/cloudflared", port: 3000, urlTimeoutMs: 1_000 });
  child.emitStderr("some log line\n");
  child.emitStderr("https://cheerful-otters.trycloudflare.com\n");
  const result = await promise;
  assert.equal(result.url, "https://cheerful-otters.trycloudflare.com");
});

test("startCloudflaredTunnel rejects when cloudflared exits before reporting a URL", async () => {
  const child = fakeChild();
  const spawnFn: TunnelSpawnFn = () => child;
  const promise = startCloudflaredTunnel({ spawnFn, cloudflaredPath: "/usr/local/bin/cloudflared", port: 3000, urlTimeoutMs: 1_000 });
  child.emitExit(1);
  await assert.rejects(promise, /exited before reporting/);
});

test("startCloudflaredTunnel rejects and kills the child on timeout", async () => {
  const child = fakeChild();
  const spawnFn: TunnelSpawnFn = () => child;
  const promise = startCloudflaredTunnel({ spawnFn, cloudflaredPath: "/usr/local/bin/cloudflared", port: 3000, urlTimeoutMs: 5 });
  await assert.rejects(promise, /Timed out/);
  assert.equal(child.killed, true);
});

test("TunnelManager refuses to start when cloudflared is missing", async () => {
  const manager = new TunnelManager({ spawnFn: () => fakeChild(), findCloudflaredPath: () => undefined });
  await assert.rejects(
    manager.start({ projectName: "web", port: 3000, startedBy: "owner-1", channelId: "chan-1", onExpire: () => {} }),
    /cloudflared is not installed/
  );
});

test("TunnelManager enforces one active tunnel per project", async () => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn: TunnelSpawnFn = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };
  const manager = new TunnelManager({ spawnFn, findCloudflaredPath: () => "/usr/local/bin/cloudflared" });

  const startPromise = manager.start({ projectName: "web", port: 3000, startedBy: "owner-1", channelId: "chan-1", onExpire: () => {} });
  children[0]?.emitStdout("https://first-tunnel.trycloudflare.com\n");
  const tunnel = await startPromise;
  assert.equal(tunnel.url, "https://first-tunnel.trycloudflare.com");

  await assert.rejects(
    manager.start({ projectName: "web", port: 3000, startedBy: "owner-1", channelId: "chan-1", onExpire: () => {} }),
    /already has an active preview tunnel/
  );
});

test("TunnelManager stop kills the child, clears the timer, and removes the tunnel", async () => {
  const clearedHandles: unknown[] = [];
  const scheduled: Array<{ fn: () => void; ms: number; handle: unknown }> = [];
  const spawnFn: TunnelSpawnFn = () => fakeChild();
  const manager = new TunnelManager({
    spawnFn,
    findCloudflaredPath: () => "/usr/local/bin/cloudflared",
    scheduleTimeout: (fn, ms) => {
      const handle = { fn, ms };
      scheduled.push({ fn, ms, handle });
      return handle;
    },
    clearScheduledTimeout: (handle) => clearedHandles.push(handle)
  });

  const startPromise = manager.start({ projectName: "web", port: 3000, ttlMinutes: 10, startedBy: "owner-1", channelId: "chan-1", onExpire: () => {} });
  const child = lastSpawnedChild;
  child?.emitStdout("https://web.trycloudflare.com\n");
  await startPromise;

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.ms, 10 * 60_000);
  assert.equal(manager.hasActive("web"), true);

  const stopped = manager.stop("web");
  assert.equal(stopped?.url, "https://web.trycloudflare.com");
  assert.equal(manager.hasActive("web"), false);
  assert.equal(clearedHandles.length, 1);
  assert.equal(child?.killed, true);
});

test("TunnelManager TTL expiry kills the child and invokes onExpire with reason ttl", async () => {
  let scheduledFn: (() => void) | undefined;
  const spawnFn: TunnelSpawnFn = () => fakeChild();
  const manager = new TunnelManager({
    spawnFn,
    findCloudflaredPath: () => "/usr/local/bin/cloudflared",
    scheduleTimeout: (fn) => {
      scheduledFn = fn;
      return "handle";
    },
    clearScheduledTimeout: () => {}
  });

  let expired: { reason: string } | undefined;
  const startPromise = manager.start({
    projectName: "web",
    port: 3000,
    startedBy: "owner-1",
    channelId: "chan-1",
    onExpire: (_tunnel, reason) => {
      expired = { reason };
    }
  });
  const child = lastSpawnedChild;
  child?.emitStdout("https://web.trycloudflare.com\n");
  await startPromise;

  assert.ok(scheduledFn);
  scheduledFn?.();
  assert.equal(manager.hasActive("web"), false);
  assert.equal(expired?.reason, "ttl");
  assert.equal(child?.killed, true);
});

test("TunnelManager unexpected process exit removes the tunnel and reports process-exit", async () => {
  const spawnFn: TunnelSpawnFn = () => fakeChild();
  const manager = new TunnelManager({
    spawnFn,
    findCloudflaredPath: () => "/usr/local/bin/cloudflared",
    scheduleTimeout: () => "handle",
    clearScheduledTimeout: () => {}
  });

  let expired: { reason: string } | undefined;
  const startPromise = manager.start({
    projectName: "web",
    port: 3000,
    startedBy: "owner-1",
    channelId: "chan-1",
    onExpire: (_tunnel, reason) => {
      expired = { reason };
    }
  });
  const child = lastSpawnedChild;
  child?.emitStdout("https://web.trycloudflare.com\n");
  await startPromise;

  child?.emitExit(1);
  assert.equal(manager.hasActive("web"), false);
  assert.equal(expired?.reason, "process-exit");
});

test("TunnelManager stopAll stops every active tunnel", async () => {
  const spawnFn: TunnelSpawnFn = () => fakeChild();
  const manager = new TunnelManager({
    spawnFn,
    findCloudflaredPath: () => "/usr/local/bin/cloudflared",
    scheduleTimeout: () => "handle",
    clearScheduledTimeout: () => {}
  });

  const first = manager.start({ projectName: "web", port: 3000, startedBy: "owner-1", channelId: "chan-1", onExpire: () => {} });
  lastSpawnedChild?.emitStdout("https://web.trycloudflare.com\n");
  await first;

  const second = manager.start({ projectName: "api", port: 4000, startedBy: "owner-1", channelId: "chan-1", onExpire: () => {} });
  lastSpawnedChild?.emitStdout("https://api.trycloudflare.com\n");
  await second;

  const stopped = manager.stopAll();
  assert.equal(stopped.length, 2);
  assert.equal(manager.list().length, 0);
});

let lastSpawnedChild: ReturnType<typeof fakeChild> | undefined;

function fakeChild(): TunnelChildProcess & { emitStdout(chunk: string): void; emitStderr(chunk: string): void; emitExit(code: number | null): void; killed: boolean } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  const child = {
    pid: 1234,
    stdout,
    stderr,
    killed: false,
    on: emitter.on.bind(emitter),
    kill(_signal?: NodeJS.Signals) {
      child.killed = true;
      return true;
    },
    emitStdout(chunk: string) {
      stdout.emit("data", chunk);
    },
    emitStderr(chunk: string) {
      stderr.emit("data", chunk);
    },
    emitExit(code: number | null) {
      emitter.emit("exit", code, null);
    }
  };
  lastSpawnedChild = child;
  return child;
}

function fakeProject(name: string): ProjectEntry {
  return {
    name,
    root: `/tmp/${name}`,
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
