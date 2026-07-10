import assert from "node:assert/strict";
import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";
import { canAutoCaptureProject, captureFileName, isSafeCaptureFileName, pruneCaptures, resolveShipImage } from "./visual-capture.js";

function project(overrides: Partial<ProjectEntry["metadata"]["policy"]> = {}): ProjectEntry {
  return {
    name: "webapp",
    root: "/tmp/webapp-does-not-exist",
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
        approvalRequiredCommands: [],
        ...overrides
      }
    }
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-abc",
    status: "succeeded",
    source: "test",
    mode: "action",
    projectName: "webapp",
    requester: "tester",
    text: "Make the header sticky",
    includePatterns: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    ...overrides
  };
}

test("canAutoCaptureProject only allows the allow screenshot policy", () => {
  assert.equal(canAutoCaptureProject(project({ screenshotPolicy: "allow" })), true);
  assert.equal(canAutoCaptureProject(project({ screenshotPolicy: "approval" })), false);
  assert.equal(canAutoCaptureProject(project({ screenshotPolicy: "deny" })), false);
});

test("captureFileName is stable and namespaced per task", () => {
  assert.equal(captureFileName("task-abc", "after"), "task-abc-after.png");
  assert.equal(captureFileName("task-abc", "ship"), "task-abc-ship.png");
});

test("isSafeCaptureFileName rejects traversal, absolute paths, and non-basenames", () => {
  assert.equal(isSafeCaptureFileName("task-abc-ship.png"), true);
  assert.equal(isSafeCaptureFileName("../../etc/passwd.png"), false);
  assert.equal(isSafeCaptureFileName("/etc/passwd.png"), false);
  assert.equal(isSafeCaptureFileName("task/abc.png"), false);
  assert.equal(isSafeCaptureFileName("task-abc.png\0.png"), false);
  assert.equal(isSafeCaptureFileName("task-abc.txt"), false);
});

test("resolveShipImage reports isolated tasks as unavailable without attempting a screenshot", async () => {
  // The project's configured frontendUrl would make findProjectWebUrls/captureProjectScreenshot
  // reach for a real page if the isolation check didn't short-circuit first — this proves an
  // isolated task never gets a screenshot of the (unrelated) source checkout attached as "proof".
  const isolatedProject = project();
  isolatedProject.metadata.frontendUrl = "http://127.0.0.1:59999";

  const result = await resolveShipImage(
    task({ workspaceIsolated: true, branchName: "devbot/task/task-abc" }),
    isolatedProject
  );
  assert.deepEqual(result, { isolated: true, branch: "devbot/task/task-abc" });
});

test("resolveShipImage returns undefined without a screenshot when auto-capture is blocked", async () => {
  const result = await resolveShipImage(task({}), project({ screenshotPolicy: "deny" }));
  assert.equal(result, undefined);
});

test("resolveShipImage returns undefined for a non-isolated task with no reachable dev server", async () => {
  const result = await resolveShipImage(task({}), project());
  assert.equal(result, undefined);
});

test("pruneCaptures keeps only the most recently written files", async () => {
  const captureRoot = await mkdtemp(path.join(tmpdir(), "devbot-captures-"));
  const names = ["task-1-ship.png", "task-2-ship.png", "task-3-ship.png"];
  for (const [index, name] of names.entries()) {
    await writeFile(path.join(captureRoot, name), Buffer.from("x"));
    const time = new Date(2026, 0, 1, 0, index);
    await utimes(path.join(captureRoot, name), time, time);
  }

  await pruneCaptures(captureRoot, 2);

  const remaining = (await readdir(captureRoot)).sort();
  assert.deepEqual(remaining, ["task-2-ship.png", "task-3-ship.png"]);
});

test("pruneCaptures ignores unsafe file names instead of deleting them", async () => {
  const captureRoot = await mkdtemp(path.join(tmpdir(), "devbot-captures-"));
  await writeFile(path.join(captureRoot, "task-1-ship.png"), Buffer.from("x"));
  await writeFile(path.join(captureRoot, "not-a-capture.txt"), Buffer.from("x"));

  await pruneCaptures(captureRoot, 0);

  const remaining = (await readdir(captureRoot)).sort();
  assert.deepEqual(remaining, ["not-a-capture.txt"]);
});

test("pruneCaptures is a no-op when the capture root does not exist yet", async () => {
  const captureRoot = path.join(tmpdir(), `devbot-captures-missing-${Date.now()}`);
  await assert.doesNotReject(pruneCaptures(captureRoot, 1));
});
