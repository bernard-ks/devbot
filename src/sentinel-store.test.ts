import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clampIntervalSeconds,
  isValidExpectedStatusSpec,
  normalizeManualPath,
  parseExpectedStatusSpec,
  SentinelStore
} from "./sentinel-store.js";

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

test("normalizeManualPath rejects urls carrying embedded credentials even on loopback", () => {
  assert.equal(normalizeManualPath("http://admin:hunter2@127.0.0.1:9/status"), "");
  assert.equal(normalizeManualPath("http://token@localhost:9/status"), "");
});

test("parseExpectedStatusSpec accepts a code, a range, and a comma list; rejects garbage", () => {
  assert.equal(parseExpectedStatusSpec("404")?.(404), true);
  assert.equal(parseExpectedStatusSpec("404")?.(200), false);
  assert.equal(parseExpectedStatusSpec("200-299")?.(250), true);
  assert.equal(parseExpectedStatusSpec("200-299")?.(404), false);
  assert.equal(parseExpectedStatusSpec("200,301,304")?.(301), true);
  assert.equal(parseExpectedStatusSpec("200,301,304")?.(302), false);
  assert.equal(parseExpectedStatusSpec(""), undefined);
  assert.equal(parseExpectedStatusSpec("not-a-status"), undefined);
  assert.equal(parseExpectedStatusSpec("999"), undefined, "out of HTTP status range");
  assert.equal(parseExpectedStatusSpec("300-200"), undefined, "an inverted range is invalid");
  assert.equal(isValidExpectedStatusSpec("200-299"), true);
  assert.equal(isValidExpectedStatusSpec("bogus"), false);
});

test("sentinel store defaults, persists config, and survives reload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-store-"));
  const filePath = path.join(root, "sentinel.json");
  const store = new SentinelStore(filePath);

  const defaults = await store.getProjectConfig("demo");
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.intervalSeconds, 120);
  assert.deepEqual(defaults.manualPaths, []);

  await store.setEnabled("demo", true, "controller-1");
  await store.setIntervalSeconds("demo", 20);
  await store.addWatchPath("demo", "admin");
  await store.addWatchPath("demo", "admin");
  await store.addWatchPath("demo", "/health");
  await store.setFastCommand("demo", "test");

  const reloaded = await new SentinelStore(filePath).getProjectConfig("demo");
  assert.equal(reloaded.enabled, true, "an enabled record with an attributable actor survives reload");
  assert.equal(reloaded.intervalSeconds, 30, "interval below the floor is clamped on write");
  assert.deepEqual(reloaded.manualPaths, ["/admin", "/health"], "duplicate watch paths are not added twice");
  assert.equal(reloaded.fastCommand, "test");

  await store.removeWatchPath("demo", "/admin");
  const afterRemoval = await store.getProjectConfig("demo");
  assert.deepEqual(afterRemoval.manualPaths, ["/health"]);
});

test("sentinel store records the enabling controller and clears it when disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-actor-"));
  const filePath = path.join(root, "sentinel.json");
  const store = new SentinelStore(filePath);

  const enabled = await store.setEnabled("demo", true, "controller-42");
  assert.equal(enabled.enabledBy, "controller-42", "the enabling actor is recorded");

  const reloaded = await new SentinelStore(filePath).getProjectConfig("demo");
  assert.equal(reloaded.enabledBy, "controller-42", "the enabling actor survives reload for per-cycle revalidation");

  const disabled = await store.setEnabled("demo", false);
  assert.equal(disabled.enabledBy, undefined, "disabling clears the recorded actor");

  const reEnabledWithoutActor = await store.setEnabled("demo", true);
  assert.equal(reEnabledWithoutActor.enabledBy, undefined, "enabling without an actor leaves no stale attribution");
});

test("sentinel store persists and reloads an expected-status option, rejecting an invalid one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-status-store-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));

  const withStatus = await store.setExpectedStatus("demo", "200-299");
  assert.equal(withStatus.expectedStatus, "200-299");

  const rejected = await store.setExpectedStatus("demo", "not-a-status");
  assert.equal(rejected.expectedStatus, undefined, "an invalid spec clears the option instead of persisting garbage");

  const withStatusAgain = await store.setExpectedStatus("demo", "404");
  const reloaded = await new SentinelStore(path.join(root, "sentinel.json")).getProjectConfig("demo");
  assert.equal(withStatusAgain.expectedStatus, "404");
  assert.equal(reloaded.expectedStatus, "404");
});

test("sentinel state file and directory are hardened to owner-only permissions", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-perms-"));
  const filePath = path.join(root, "nested", "sentinel.json");
  const store = new SentinelStore(filePath);
  await store.setEnabled("demo", true);

  const fileStat = await stat(filePath);
  assert.equal(fileStat.mode & 0o777, 0o600, "the state file must not be group/world readable");

  const dirStat = await stat(path.dirname(filePath));
  assert.equal(dirStat.mode & 0o777, 0o700, "the state directory must not be group/world accessible");
});

test("sentinel store discards malformed watch entries instead of trusting arbitrary JSON, and rejects an unsupported version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-schema-"));
  const filePath = path.join(root, "sentinel.json");
  await mkdir(root, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      projects: {
        demo: {
          config: { enabled: "yes", intervalSeconds: "soon", manualPaths: ["admin", 42, "http://evil.example.com/x"], fastCommand: 7 },
          watches: {
            "url-a": { kind: "url", target: "http://127.0.0.1:3000", status: "bogus-status", consecutiveFailures: -3 },
            "url-b": { kind: "not-a-kind", target: "http://127.0.0.1:3000" },
            "url-c": "not even an object",
            "url-d": { kind: "url", status: "up", consecutiveFailures: 1 }
          }
        }
      }
    })
  );

  const store = new SentinelStore(filePath);
  const config = await store.getProjectConfig("demo");
  assert.equal(config.enabled, false, "a non-boolean enabled value must not be trusted as true");
  assert.equal(config.intervalSeconds, 120, "a non-numeric interval falls back to the default");
  assert.deepEqual(config.manualPaths, ["/admin"], "non-string entries and rejected SSRF targets are dropped");
  assert.equal(config.fastCommand, undefined, "a non-string fastCommand must not be trusted");

  const watches = await store.listProjectWatches("demo");
  assert.equal(watches.length, 1, "only the structurally valid watch entry survives normalization");
  assert.equal(watches[0]?.id, "url-a");
  assert.equal(watches[0]?.status, "unknown", "an invalid status falls back to unknown rather than being trusted");
  assert.equal(watches[0]?.consecutiveFailures, 0, "a negative failure count is not trusted");

  await writeFile(filePath, JSON.stringify({ version: 2, projects: {} }));
  await assert.rejects(() => new SentinelStore(filePath).getProjectConfig("demo"), /Unsupported sentinel state version/);
});

test("an enabled legacy record with no enabledBy is disabled on load, not left running without an actor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-legacy-"));
  const filePath = path.join(root, "sentinel.json");
  await mkdir(root, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      projects: {
        legacy: { config: { enabled: true, intervalSeconds: 120 }, watches: {} },
        attributed: { config: { enabled: true, enabledBy: "controller-1", intervalSeconds: 120 }, watches: {} }
      }
    })
  );

  const store = new SentinelStore(filePath);
  const legacy = await store.getProjectConfig("legacy");
  assert.equal(legacy.enabled, false, "an enabled record without an enabling actor is disabled on load, fail closed");
  assert.equal(legacy.enabledBy, undefined, "no stale actor attribution is fabricated");

  const attributed = await store.getProjectConfig("attributed");
  assert.equal(attributed.enabled, true, "an enabled record with an attributable actor stays enabled");
  assert.equal(attributed.enabledBy, "controller-1", "the enabling actor survives for per-cycle revalidation");
});

test("sentinel store redacts secret-shaped error text and target strings before persisting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-sentinel-redact-"));
  const store = new SentinelStore(path.join(root, "sentinel.json"));

  await store.saveWatchState("demo", "cmd-test", {
    id: "cmd-test",
    kind: "command",
    target: "npm test",
    status: "down",
    consecutiveFailures: 2,
    lastError: "command failed: API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890 request denied"
  });

  const saved = await store.getWatchState("demo", "cmd-test");
  assert.ok(saved?.lastError && !saved.lastError.includes("sk-abcdefghijklmnopqrstuvwxyz1234567890"), "a secret-shaped token must be redacted before it ever reaches disk");
  assert.match(saved?.lastError ?? "", /REDACTED/);
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
