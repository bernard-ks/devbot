import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewPacket } from "./review.js";
import { buildStudioSnapshot, isStudioTaskVisible, sanitizeStudioText } from "./studio-data.js";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";

const project: ProjectEntry = {
  name: "devbot",
  root: "/private/local/devbot",
  metadata: {
    canonicalName: "devbot",
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
      screenshotPolicy: "approval",
      maxContextChars: undefined,
      readOnlyCommands: [],
      approvalRequiredCommands: []
    }
  }
};

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-alpha",
    status: "running",
    source: "slash:do",
    mode: "action",
    projectName: "devbot",
    requester: "bernard",
    text: "Build Devbot Studio",
    includePatterns: [],
    startedAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:01:00.000Z",
    ...overrides
  };
}

function review(overrides: Partial<ReviewPacket> = {}): ReviewPacket {
  return {
    project,
    task: undefined,
    branch: "codex/studio",
    defaultBranch: "main",
    status: "M src/index.ts\n?? studio/index.html",
    diffStat: "2 files changed, 42 insertions(+)",
    lastCommit: "abc123 Start Studio",
    ...overrides
  };
}

test("Studio snapshot maps task lanes, branch state, and proof without local paths", () => {
  const snapshot = buildStudioSnapshot({
    generatedAt: new Date("2026-07-10T10:02:00.000Z"),
    bot: { name: "devbot", owner: "local", safeMode: false },
    tasks: [
      task({
        agentRoles: ["builder", "reviewer"],
        branchName: "devbot/task/studio",
        baseBranch: "main",
        workspacePath: "/private/worktree/never-expose",
        workspaceIsolated: true,
        changedFiles: ["src/index.ts", "studio/src/main.ts"],
        verification: ["npm test in /Users/bernard/devbot: passed"],
        diffStat: "2 files changed",
        captureNote: "Screenshot captured at /private/worktree/never-expose/proof.png.",
        resultPreview: "Updated /Users/bernard/devbot/src/index.ts while process pid 1234 was active."
      }),
      task({
        id: "task-beta",
        status: "awaiting-approval",
        attention: "approval",
        approvalStatus: "pending",
        text: "Approve the launch flow"
      }),
      task({ id: "task-gamma", status: "succeeded", text: "Document Studio", finishedAt: "2026-07-10T10:01:30.000Z" }),
      task({ id: "task-internal", internal: true, accessScope: "workroom", text: "Private reviewer prompt" }),
      task({ id: "task-legacy-seat", source: "lab:council:verification", text: "Legacy sealed council prompt" }),
      task({ id: "task-status-detail", source: "status-detail", text: "Current process pid 999 in /Users/bernard/project" })
    ],
    reviews: [review()],
    privatePaths: ["/Users/bernard/devbot", "/private/worktree/never-expose"]
  });

  assert.deepEqual(snapshot.totals, { needsMe: 1, inFlight: 1, recent: 1, projects: 1 });
  assert.equal(snapshot.tasks[0]?.lane, "in-flight");
  assert.equal(snapshot.tasks[1]?.lane, "needs-me");
  assert.equal(snapshot.tasks[2]?.lane, "recent");
  assert.equal(snapshot.tasks.some((item) => item.id === "task-internal"), false);
  assert.equal(snapshot.tasks.some((item) => item.id === "task-legacy-seat"), false);
  assert.equal(snapshot.tasks.some((item) => item.id === "task-status-detail"), false);
  assert.equal(snapshot.projects[0]?.dirty, true);
  assert.equal(snapshot.agents.find((agent) => agent.id === "builder")?.status, "active");
  assert.doesNotMatch(JSON.stringify(snapshot), /private\/worktree|private\/local|\/Users\/|pid 1234/);
  assert.match(snapshot.tasks[0]?.result ?? "", /\[local path\]|process \[redacted\]/);
});

test("Studio task visibility excludes legacy internal sources and text sanitizer removes local identity", () => {
  assert.equal(isStudioTaskVisible(task({ source: "workroom:agent:reviewer" })), false);
  assert.equal(isStudioTaskVisible(task({ source: "lab:council:systems" })), false);
  assert.equal(isStudioTaskVisible(task({ source: "status-detail" })), false);
  assert.equal(isStudioTaskVisible(task({ source: "slash:do" })), true);
  assert.equal(
    sanitizeStudioText("Open /Users/bernard/My Project/file.ts while pid 4096 runs", ["/Users/bernard/My Project"]),
    "Open [local path]/file.ts while process [redacted] runs"
  );
});

test("Studio snapshot bounds long task and evidence values", () => {
  const snapshot = buildStudioSnapshot({
    bot: { name: "devbot", owner: "local", safeMode: true },
    tasks: [task({ text: "x".repeat(1_000), changedFiles: Array.from({ length: 20 }, (_, index) => `file-${index}.ts`) })],
    reviews: [review({ status: "", diffStat: "" })]
  });

  assert.ok((snapshot.tasks[0]?.title.length ?? 0) <= 240);
  assert.equal(snapshot.tasks[0]?.evidence.changedFiles.length, 8);
  assert.equal(snapshot.projects[0]?.dirty, false);
  assert.equal(snapshot.bot.safeMode, true);
});
