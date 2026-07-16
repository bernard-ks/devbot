import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { clearRuntimeLock, isRuntimeRunning, markRuntimeRunning } from "./runtime-lock.js";

test("runtime lock records process identity and clears only its own lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-runtime-lock-"));
  const lockFile = path.join(root, "runtime.pid");

  markRuntimeRunning(lockFile);
  const record = JSON.parse(await readFile(lockFile, "utf8")) as {
    version: number;
    pid: number;
    createdAt: string;
    ownerId: string;
    processIdentity?: string;
  };
  assert.equal(record.version, 1);
  assert.equal(record.pid, process.pid);
  assert.equal(Number.isFinite(Date.parse(record.createdAt)), true);
  assert.match(record.ownerId, /^[a-f0-9]{32}$/);
  if (process.platform !== "win32") assert.equal(typeof record.processIdentity, "string");

  assert.equal(isRuntimeRunning(lockFile), true);
  assert.throws(() => markRuntimeRunning(lockFile), /Another Devbot runtime already owns/);
  clearRuntimeLock(lockFile);
  assert.equal(existsSync(lockFile), false);
});

test("runtime lock removes malformed and dead-PID files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-runtime-stale-"));
  const lockFile = path.join(root, "runtime.pid");

  await writeFile(lockFile, "not-a-pid\n");
  assert.equal(isRuntimeRunning(lockFile), false);
  assert.equal(existsSync(lockFile), false);

  await writeFile(lockFile, `${JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    createdAt: new Date().toISOString(),
    ownerId: "stale-owner"
  })}\n`);
  assert.equal(isRuntimeRunning(lockFile), false);
  assert.equal(existsSync(lockFile), false);
});

test("runtime lock remains compatible with legacy PID-only files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-runtime-legacy-"));
  const lockFile = path.join(root, "runtime.pid");

  await writeFile(lockFile, `${process.pid}\n`);
  assert.equal(isRuntimeRunning(lockFile), true);
  clearRuntimeLock(lockFile);
  assert.equal(existsSync(lockFile), false);
});

test("runtime lock rejects a recycled PID when the process identity differs", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows uses conservative PID liveness because no portable start identity is available");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "devbot-runtime-recycled-"));
  const lockFile = path.join(root, "runtime.pid");
  await writeFile(lockFile, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerId: "old-runtime-owner",
    processIdentity: "identity-from-an-older-process"
  })}\n`);

  assert.equal(isRuntimeRunning(lockFile), false);
  assert.equal(existsSync(lockFile), false);
  markRuntimeRunning(lockFile);
  assert.equal(isRuntimeRunning(lockFile), true);
  clearRuntimeLock(lockFile);
});

test("clearRuntimeLock does not remove another owner's lock even with the same PID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-runtime-owner-"));
  const lockFile = path.join(root, "runtime.pid");
  await writeFile(lockFile, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerId: "another-runtime-owner"
  })}\n`);

  clearRuntimeLock(lockFile);
  assert.equal(existsSync(lockFile), true);
});
