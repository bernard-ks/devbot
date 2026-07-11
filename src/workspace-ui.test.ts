import assert from "node:assert/strict";
import test from "node:test";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";
import {
  compactStatus,
  parseWorkspaceControl,
  parseWorkspaceModal,
  workspaceLauncherView,
  workspacePanelView,
  workspaceRecentTasks,
  workspaceRequestModal
} from "./workspace-ui.js";

test("workspace controls and modals use stable scoped IDs", () => {
  assert.deepEqual(parseWorkspaceControl("devbot:workspace:open"), { action: "open" });
  assert.deepEqual(parseWorkspaceControl("devbot:workspace:ask:pullprice"), { action: "ask", projectName: "pullprice" });
  assert.deepEqual(parseWorkspaceControl("devbot:workspace:project"), { action: "project" });
  assert.equal(parseWorkspaceControl("devbot:workspace:act:../../private"), undefined);
  assert.deepEqual(parseWorkspaceModal("devbot:workspace-modal:act:pullprice"), { action: "act", projectName: "pullprice" });
  assert.equal(parseWorkspaceModal("devbot:workspace-modal:act:pullprice:extra"), undefined);

  const launcher = workspaceLauncherView();
  assert.match(launcher.content, /Devbot workspace/);
  const launcherButton = launcher.components[0]?.toJSON().components[0];
  assert.equal(launcherButton && "custom_id" in launcherButton ? launcherButton.custom_id : undefined, "devbot:workspace:open");
  assert.equal(workspaceRequestModal("ask", "pullprice").toJSON().custom_id, "devbot:workspace-modal:ask:pullprice");
});

test("workspace panel is project-aware and keeps write controls role-aware", () => {
  const pullprice = project("pullprice", true);
  const api = project("api", false);
  const status = [
    "**Development status**",
    "",
    "**Now**",
    "No Devbot-managed task is confirmed running.",
    "",
    "**Repository evidence**",
    "- `pullprice`: branch `main`; working tree clean.",
    "",
    "**Blockers and risks**",
    "- No explicit blocker is visible.",
    "",
    "**Best next step**",
    "Ready for the next assignment."
  ].join("\n");
  const task = recentTask();
  const viewer = workspacePanelView({
    projects: [pullprice, api],
    selectedProject: pullprice,
    canControl: false,
    studioEnabled: true,
    safeMode: false,
    status,
    recentTasks: [task],
    needsAttentionCount: 2
  });
  const rows = viewer.components.map((row) => row.toJSON());
  const makeChange = rows[0]?.components.find((component) => "custom_id" in component && component.custom_id.includes(":act:"));
  assert.match(viewer.content, /pullprice workspace/);
  assert.match(viewer.content, /working tree clean/);
  assert.match(viewer.content, /Done \| Answer/);
  assert.doesNotMatch(viewer.content, /task-abc/);
  assert.equal(makeChange && "disabled" in makeChange ? makeChange.disabled : undefined, true);
  const openStudio = rows[1]?.components.find((component) => "custom_id" in component && component.custom_id.includes(":studio:"));
  assert.equal(openStudio && "disabled" in openStudio ? openStudio.disabled : undefined, true);
  assert.equal(rows[2]?.components[0]?.type, 3);
  assert.match(JSON.stringify(rows[0]), /Needs Me \(2\)/);

  const controller = workspacePanelView({
    projects: [pullprice],
    selectedProject: pullprice,
    canControl: true,
    studioEnabled: true,
    safeMode: false,
    status,
    recentTasks: []
  });
  const controllerMakeChange = controller.components[0]?.toJSON().components.find(
    (component) => "custom_id" in component && component.custom_id.includes(":act:")
  );
  assert.equal(controllerMakeChange && "disabled" in controllerMakeChange ? controllerMakeChange.disabled : undefined, false);
  const controllerStudio = controller.components[1]?.toJSON().components.find(
    (component) => "custom_id" in component && component.custom_id.includes(":studio:")
  );
  assert.equal(controllerStudio && "disabled" in controllerStudio ? controllerStudio.disabled : undefined, false);

  const studioOff = workspacePanelView({
    projects: [pullprice],
    selectedProject: pullprice,
    canControl: true,
    studioEnabled: false,
    safeMode: false,
    status,
    recentTasks: []
  });
  const disabledStudio = studioOff.components[1]?.toJSON().components.find(
    (component) => "custom_id" in component && component.custom_id.includes(":studio:")
  );
  assert.equal(disabledStudio && "disabled" in disabledStudio ? disabledStudio.disabled : undefined, true);
  assert.match(JSON.stringify(disabledStudio), /Studio off/);
});

test("workspace status compaction preserves now risk and next", () => {
  const compact = compactStatus(
    "**Now**\nWorking on tests.\n\n**Blockers and risks**\n- Tests are failing.\n\n**Best next step**\nRun the focused suite."
  );
  assert.match(compact, /Working on tests/);
  assert.match(compact, /Tests are failing/);
  assert.match(compact, /Run the focused suite/);
});

test("workspace recent work hides internal council and agent seats", () => {
  const visible = recentTask();
  const internal = { ...recentTask(), id: "task-council", source: "lab:council:systems", text: "sealed seat prompt" };
  const agent = { ...recentTask(), id: "task-agent", source: "workroom:agent:reviewer", text: "review seat prompt" };
  assert.deepEqual(workspaceRecentTasks([internal, agent, visible]).map((task) => task.id), [visible.id]);
});

function project(name: string, isDefault: boolean): ProjectEntry {
  return {
    name,
    root: `/tmp/${name}`,
    isDefault,
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
        approvalRequiredCommands: []
      }
    }
  };
}

function recentTask(): TaskRecord {
  return {
    id: "task-abc",
    status: "succeeded",
    source: "test",
    mode: "answer",
    projectName: "pullprice",
    requester: "tester",
    text: "Explain the pricing flow",
    includePatterns: [],
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:01:00.000Z",
    finishedAt: "2026-07-10T00:01:00.000Z"
  };
}
