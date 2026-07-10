import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";
import { canAutoCaptureProject, captureFileName, resolveShipImage } from "./visual-capture.js";

function project(overrides: Partial<ProjectEntry["metadata"]["policy"]> = {}): ProjectEntry {
  return {
    name: "webapp",
    root: "/tmp/webapp",
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
  assert.equal(captureFileName("task-abc", "diff-card"), "task-abc-diff-card.png");
});

test("resolveShipImage prefers the diff card over the raw after screenshot", async () => {
  const captureRoot = await mkdtemp(path.join(tmpdir(), "devbot-captures-"));
  await mkdir(captureRoot, { recursive: true });
  await writeFile(path.join(captureRoot, "task-abc-after.png"), Buffer.from("after-bytes"));
  await writeFile(path.join(captureRoot, "task-abc-diff-card.png"), Buffer.from("card-bytes"));

  const result = await resolveShipImage(
    task({ captureAfterFile: "task-abc-after.png", captureCardFile: "task-abc-diff-card.png", captureChangedPercent: 3.2 }),
    project(),
    captureRoot
  );
  assert.ok(result);
  assert.equal(result?.image.toString(), "card-bytes");
  assert.equal(result?.changedPercent, 3.2);
  assert.equal(result?.isLiveFallback, false);
});

test("resolveShipImage falls back to the after screenshot when the card file is missing", async () => {
  const captureRoot = await mkdtemp(path.join(tmpdir(), "devbot-captures-"));
  await writeFile(path.join(captureRoot, "task-abc-after.png"), Buffer.from("after-bytes"));

  const result = await resolveShipImage(
    task({ captureAfterFile: "task-abc-after.png", captureCardFile: "missing-card.png" }),
    project(),
    captureRoot
  );
  assert.ok(result);
  assert.equal(result?.image.toString(), "after-bytes");
});

test("resolveShipImage returns undefined without captures when auto-capture is blocked", async () => {
  const captureRoot = await mkdtemp(path.join(tmpdir(), "devbot-captures-"));
  const result = await resolveShipImage(task({}), project({ screenshotPolicy: "deny" }), captureRoot);
  assert.equal(result, undefined);
});
