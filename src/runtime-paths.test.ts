import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultRuntimeStatePath,
  migrateLegacyRuntimeState,
  runtimeStatePath,
  runtimeStateRoot
} from "./runtime-paths.js";
import { acquireRuntimeStateLease } from "./runtime-state.js";

test("runtime state defaults outside the current checkout", () => {
  assert.equal(runtimeStateRoot("/tmp/devbot-state"), path.resolve("/tmp/devbot-state"));
  assert.equal(runtimeStatePath("tasks.json", "/tmp/devbot-state"), path.resolve("/tmp/devbot-state/tasks.json"));
  assert.throws(() => runtimeStatePath("../secrets.json", "/tmp/devbot-state"), /without parent traversal/);
});

test("default runtime path resolution is pure and explicit migration moves recognized state", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "devbot-runtime-paths-"));
  const checkout = path.join(fixture, "checkout");
  const legacy = path.join(checkout, ".devbot");
  const state = path.join(fixture, "state");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "tasks.json"), "legacy\n");
  await writeFile(path.join(legacy, "project.json"), "{}\n");

  const previousState = process.env.DEVBOT_STATE_DIR;
  process.env.DEVBOT_STATE_DIR = state;
  try {
    const resolved = defaultRuntimeStatePath("tasks.json");
    assert.equal(resolved, path.join(state, "tasks.json"));
    assert.equal(existsSync(resolved), false, "resolving a default path must not mutate the filesystem");
    assert.deepEqual(migrateLegacyRuntimeState({ legacyRoot: legacy, targetRoot: state, environment: {} }), ["tasks.json"]);
    assert.equal(await readFile(resolved, "utf8"), "legacy\n");
    assert.equal(existsSync(path.join(legacy, "project.json")), true, "repository metadata stays in place");
  } finally {
    if (previousState === undefined) delete process.env.DEVBOT_STATE_DIR;
    else process.env.DEVBOT_STATE_DIR = previousState;
  }
});

test("runtime migration refuses a symlinked legacy state directory", { skip: process.platform === "win32" }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "devbot-runtime-symlink-"));
  const checkout = path.join(fixture, "checkout");
  const outside = path.join(fixture, "outside");
  await mkdir(checkout);
  await mkdir(outside);
  await writeFile(path.join(outside, "tasks.json"), "{}\n");
  await symlink(outside, path.join(checkout, ".devbot"));
  assert.throws(
    () => migrateLegacyRuntimeState({ legacyRoot: path.join(checkout, ".devbot"), targetRoot: path.join(fixture, "state") }),
    /symlinked legacy runtime directory/
  );
});

test("runtime migration fails closed when legacy and protected copies both exist", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "devbot-runtime-conflict-"));
  const legacy = path.join(fixture, "checkout", ".devbot");
  const state = path.join(fixture, "state");
  await mkdir(legacy, { recursive: true });
  await mkdir(state);
  await writeFile(path.join(legacy, "tasks.json"), "legacy\n");
  await writeFile(path.join(state, "tasks.json"), "protected\n");
  assert.throws(() => migrateLegacyRuntimeState({ legacyRoot: legacy, targetRoot: state }), /both legacy and protected state/);
  assert.equal(await readFile(path.join(legacy, "tasks.json"), "utf8"), "legacy\n");
});

test("runtime state lease fences old and new runtimes before migration", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "devbot-runtime-lease-"));
  const legacy = path.join(fixture, "checkout", ".devbot");
  const state = path.join(fixture, "state");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "tasks.json"), "legacy\n");
  const lease = acquireRuntimeStateLease({
    legacyRoot: legacy,
    targetRoot: state,
    primaryLock: path.join(state, "runtime.pid"),
    environment: {}
  });
  try {
    assert.deepEqual(lease.migrated, ["tasks.json"]);
    assert.equal(existsSync(lease.primaryLock), true);
    assert.equal(existsSync(lease.legacyLock), true);
    assert.throws(() => acquireRuntimeStateLease({
      legacyRoot: legacy,
      targetRoot: state,
      primaryLock: path.join(state, "runtime.pid"),
      environment: {}
    }), /Another Devbot runtime already owns/);
  } finally {
    lease.release();
  }
  assert.equal(existsSync(lease.primaryLock), false);
  assert.equal(existsSync(lease.legacyLock), false);
});

test("runtime state lease honors an explicitly configured primary lock", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "devbot-runtime-custom-lock-"));
  const legacy = path.join(fixture, "checkout", ".devbot");
  const state = path.join(fixture, "state");
  const configuredLock = path.join(fixture, "locks", "custom.pid");
  await mkdir(legacy, { recursive: true });
  const lease = acquireRuntimeStateLease({
    legacyRoot: legacy,
    targetRoot: state,
    primaryLock: configuredLock,
    environment: {}
  });
  try {
    assert.equal(lease.primaryLock, configuredLock);
    assert.equal(existsSync(configuredLock), true);
    assert.equal(existsSync(path.join(state, "runtime.pid")), false);
  } finally {
    lease.release();
  }
});

test("both runtime entry points pass the configured lock into the startup lease", async () => {
  const [botSource, setupSource] = await Promise.all([
    readFile(path.resolve("src/index.ts"), "utf8"),
    readFile(path.resolve("src/setup-app.ts"), "utf8")
  ]);
  const expected = /acquireRuntimeStateLease\(\{\s*primaryLock: runtimeLockPath\(process\.env\.DEVBOT_RUNTIME_LOCK\)\s*\}\)/;
  assert.match(botSource, expected);
  assert.match(setupSource, expected);
});
