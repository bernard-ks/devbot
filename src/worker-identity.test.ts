import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { captureWorkerIdentity, probeWorker } from "./worker-identity.js";

test("captureWorkerIdentity records pid, pgid, and a start token for a live process", (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX process-group identity is not available on Windows.");
  }
  const identity = captureWorkerIdentity(process.pid);
  assert.equal(identity.pid, process.pid);
  assert.equal(identity.pgid, process.pid);
  assert.ok(identity.startToken, "expected a start token for the current process");
  assert.ok(Number.isFinite(Date.parse(identity.recordedAt)));
});

test("probeWorker reports a live captured process as alive and a gone one as dead", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX process-group identity is not available on Windows.");
  }
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore"
  });
  assert.equal(typeof child.pid, "number");
  const pid = child.pid as number;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const identity = captureWorkerIdentity(pid);

  assert.equal(probeWorker(identity), "alive");

  child.kill("SIGKILL");
  await exited;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(probeWorker(identity), "dead");
});

test("probeWorker fails closed to unknown when identity is missing or unverifiable", () => {
  assert.equal(probeWorker(undefined), "unknown");
  assert.equal(probeWorker({ pid: 0, pgid: 0, recordedAt: new Date().toISOString() }), "unknown");
  if (process.platform !== "win32") {
    // The current process is alive, but with no recorded start token its identity
    // cannot be confirmed, so recovery must not treat it as a positive match.
    assert.equal(probeWorker({ pid: process.pid, pgid: process.pid, recordedAt: new Date().toISOString() }), "unknown");
  }
});
