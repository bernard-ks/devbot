import assert from "node:assert/strict";
import test from "node:test";
import type { StudioSnapshot } from "./studio-data.js";
import {
  parseStudioControl,
  studioCustomId,
  studioDashboardCard,
  studioEnabled
} from "./studio-ui.js";

const snapshot: StudioSnapshot = {
  version: 1,
  source: "live",
  generatedAt: "2026-07-10T00:00:00.000Z",
  bot: { name: "devbot", owner: "local", safeMode: false },
  totals: { needsMe: 1, inFlight: 1, recent: 1, projects: 2 },
  projects: [
    {
      name: "pullprice",
      branch: "codex/studio",
      defaultBranch: "main",
      dirty: true,
      changedPaths: ["src/index.ts"],
      diffStat: "1 file changed",
      lastCommit: "abc123 Studio"
    },
    {
      name: "api",
      branch: "main",
      defaultBranch: "main",
      dirty: false,
      changedPaths: [],
      diffStat: null,
      lastCommit: "def456 Clean"
    }
  ],
  tasks: [
    {
      id: "task-needs-me",
      project: "pullprice",
      title: "Review @everyone [proof](https://example.com)",
      requester: "owner",
      status: "awaiting-approval",
      lane: "needs-me",
      updatedAt: "2026-07-10T00:00:00.000Z",
      result: null,
      error: null,
      roles: ["reviewer"],
      approval: { attention: "approval", status: "pending", actor: null },
      branch: { name: "codex/review", base: "main", isolated: true, merged: false },
      evidence: {
        changedFiles: ["src/review.ts"],
        diffStat: "1 file changed",
        verification: ["npm test passed at https://example.com/proof"],
        captureNote: null
      }
    },
    {
      id: "task-running",
      project: "api",
      title: "Implement endpoint",
      requester: "owner",
      status: "running",
      lane: "in-flight",
      updatedAt: "2026-07-10T00:00:00.000Z",
      result: null,
      error: null,
      roles: ["builder"],
      approval: { attention: null, status: "approved", actor: "owner" },
      branch: { name: "codex/api", base: "main", isolated: true, merged: false },
      evidence: { changedFiles: [], diffStat: null, verification: [], captureNote: null }
    },
    {
      id: "task-done",
      project: "pullprice",
      title: "Ship the UI",
      requester: "owner",
      status: "succeeded",
      lane: "recent",
      updatedAt: "2026-07-10T00:00:00.000Z",
      result: "Done",
      error: null,
      roles: ["verifier"],
      approval: { attention: null, status: "approved", actor: "owner" },
      branch: { name: "codex/ui", base: "main", isolated: true, merged: true },
      evidence: {
        changedFiles: ["src/ui.ts"],
        diffStat: "1 file changed",
        verification: ["npm test passed"],
        captureNote: "Visual proof complete"
      }
    }
  ],
  agents: [
    { id: "coordinator", name: "Devbot", role: "Coordinator", status: "waiting", taskId: "task-needs-me", taskTitle: "Review proof" },
    { id: "builder", name: "Builder", role: "Implementation", status: "active", taskId: "task-running", taskTitle: "Implement endpoint" },
    { id: "reviewer", name: "Reviewer", role: "Code review", status: "waiting", taskId: "task-needs-me", taskTitle: "Review proof" },
    { id: "verifier", name: "Verifier", role: "Proof and checks", status: "ready", taskId: null, taskTitle: null }
  ]
};

test("Studio controls are strict and bounded", () => {
  const id = studioCustomId("refresh", "pullprice");
  assert.deepEqual(parseStudioControl(id), { action: "refresh", scope: "pullprice" });
  assert.equal(parseStudioControl("devbot:studio:v1:refresh:bad:extra"), undefined);
  assert.equal(parseStudioControl("devbot:studio:v1:launch:all"), undefined);
  assert.throws(() => studioCustomId("refresh", "bad project"));
});

test("Studio is opt-in only", () => {
  assert.equal(studioEnabled({}), false);
  assert.equal(studioEnabled({ DEVBOT_STUDIO_ENABLED: "false" }), false);
  assert.equal(studioEnabled({ DEVBOT_STUDIO_ENABLED: " TRUE " }), true);
});

test("Discord-native Studio renders a bounded Components V2 workroom", () => {
  const payload = studioDashboardCard(snapshot, { selectedProject: "pullprice", selectedTaskId: "task-needs-me" });
  const json = JSON.stringify({
    flags: payload.flags,
    components: payload.components.map((component) => component.toJSON()),
    allowedMentions: payload.allowedMentions
  });
  assert.equal(payload.flags, 1 << 15);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(json, /Devbot Studio/);
  assert.match(json, /Agent map/);
  assert.match(json, /Branch state/);
  assert.match(json, /Open full task/);
  assert.doesNotMatch(json, /https:\/\/example\.com/);
  assert.doesNotMatch(json, /@everyone/);
  assert.ok(json.length < 30_000);
});

test("Studio project filters keep unrelated tasks out of the board", () => {
  const payload = studioDashboardCard(snapshot, { selectedProject: "api" });
  const json = JSON.stringify(payload.components.map((component) => component.toJSON()));
  assert.match(json, /Implement endpoint/);
  assert.doesNotMatch(json, /Ship the UI/);
  assert.doesNotMatch(json, /task-needs-me/);
});
