import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { clampIntervalSeconds, normalizeManualPath, SentinelStore } from "./sentinel-store.js";

test("clampIntervalSeconds enforces the 30 second floor and rejects non-finite input", () => {
  assert.equal(clampIntervalSeconds(120), 120);
  assert.equal(clampIntervalSeconds(5), 30);
  assert.equal(clampIntervalSeconds(30), 30);
  assert.equal(clampIntervalSeconds(45.6), 46);
  assert.equal(clampIntervalSeconds(Number.NaN), 120);
});

test("normalizeManualPath normalizes bare paths and preserves absolute urls", () => {
  assert.equal(normalizeManualPath("admin"), "/admin");
  assert.equal(normalizeManualPath("/admin/"), "/admin");
  assert.equal(normalizeManualPath("//admin//nested//"), "/admin//nested");
  assert.equal(normalizeManualPath("http://127.0.0.1:9/status/"), "http://127.0.0.1:9/status");
  assert.equal(normalizeManualPath("http://localhost:9/status"), "http://localhost:9/status");
});

test("normalizeManualPath rejects non-loopback urls to prevent sentinel from becoming an SSRF proxy", () => {
  assert.equal(normalizeManualPath("http://evil.example.com/admin"), "");
  assert.equal(normalizeManualPath("https://169.254.169.254/latest/meta-data"), "");
});

test("sentinel store defaults, persists config, and survives reload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-store-"));
  const filePath = path.join(root, "sentinel.json");
  const store = new SentinelStore(filePath);

  const defaults = await store.getProjectConfig("demo");
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.intervalSeconds, 120);
  assert.deepEqual(defaults.manualPaths, []);

  await store.setEnabled("demo", true);
  await store.setIntervalSeconds("demo", 20);
  await store.addWatchPath("demo", "admin");
  await store.addWatchPath("demo", "admin");
  await store.addWatchPath("demo", "/health");
  await store.setFastCommand("demo", "test");

  const reloaded = await new SentinelStore(filePath).getProjectConfig("demo");
  assert.equal(reloaded.enabled, true);
  assert.equal(reloaded.intervalSeconds, 30, "interval below the floor is clamped on write");
  assert.deepEqual(reloaded.manualPaths, ["/admin", "/health"], "duplicate watch paths are not added twice");
  assert.equal(reloaded.fastCommand, "test");

  await store.removeWatchPath("demo", "/admin");
  const afterRemoval = await store.getProjectConfig("demo");
  assert.deepEqual(afterRemoval.manualPaths, ["/health"]);
});

test("sentinel store tracks and mutes per-project watch state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-store-watch-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));

  assert.equal(await store.getWatchState("demo", "url-a"), undefined);

  await store.saveWatchState("demo", "url-a", {
    id: "url-a",
    kind: "url",
    target: "http://127.0.0.1:3000",
    status: "up",
    consecutiveFailures: 0
  });

  const saved = await store.getWatchState("demo", "url-a");
  assert.equal(saved?.status, "up");

  const muted = await store.muteWatch("demo", "url-a", "2026-01-01T01:00:00.000Z");
  assert.equal(muted?.mutedUntil, "2026-01-01T01:00:00.000Z");
  assert.equal(await store.muteWatch("demo", "missing-watch", "2026-01-01T01:00:00.000Z"), undefined);

  const watches = await store.listProjectWatches("demo");
  assert.equal(watches.length, 1);
  assert.deepEqual(await store.listConfiguredProjectNames(), ["demo"]);
});
