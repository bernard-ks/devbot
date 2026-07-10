import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { clearRuntimeLock, isRuntimeRunning, markRuntimeRunning } from "./runtime-lock.js";

test("runtime lock detects the live bot process and clears only its own PID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-runtime-lock-"));
  const lockFile = path.join(root, "runtime.pid");

  markRuntimeRunning(lockFile);
  assert.equal(isRuntimeRunning(lockFile), true);
  assert.throws(() => markRuntimeRunning(lockFile), /Another Devbot runtime already owns/);
  clearRuntimeLock(lockFile);
  assert.equal(existsSync(lockFile), false);

  await writeFile(lockFile, "not-a-pid\n");
  assert.equal(isRuntimeRunning(lockFile), false);
  assert.equal(existsSync(lockFile), false);
});
