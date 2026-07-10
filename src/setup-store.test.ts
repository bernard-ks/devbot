import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandDefinitions } from "./commands.js";
import { parseMentionRequest } from "./mention.js";
import { applySetupState, captureBootstrapConfig, isSetupController } from "./runtime-setup.js";
import { SetupStore, type SetupState } from "./setup-store.js";
import { parseSetupWizardAction, setupRepositoryModal, setupWizardView } from "./setup-wizard.js";
import type { AppConfig, ProjectEntry } from "./types.js";

test("setup store persists access peers repositories defaults and room", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-setup-store-"));
  const filePath = path.join(root, "setup.json");
  const repoRoot = path.join(root, "repo");
  const store = new SetupStore(filePath);

  await store.setUser("viewer-1", "view", true);
  await store.setUser("controller-1", "control", true);
  await store.setPeer("peer-1", true);
  await store.setRepository("Web App", repoRoot);
  await store.setDefaultProject("web-app");
  await store.setPrivateChannel("channel-1");
  await store.setWorkspaceMessage("message-1");

  const reloaded = new SetupStore(filePath).snapshot();
  assert.deepEqual(reloaded.viewerUserIds, ["controller-1", "viewer-1"]);
  assert.deepEqual(reloaded.controllerUserIds, ["controller-1"]);
  assert.deepEqual(reloaded.peerBotIds, ["peer-1"]);
  assert.equal(reloaded.repositories["web-app"], repoRoot);
  assert.equal(reloaded.defaultProjectName, "web-app");
  assert.equal(reloaded.privateChannelId, "channel-1");
  assert.equal(reloaded.workspaceMessageId, "message-1");
});

test("setup access changes preserve controller-viewer invariants under concurrency", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-setup-concurrency-"));
  const store = new SetupStore(path.join(root, "setup.json"));

  await Promise.all(Array.from({ length: 12 }, (_, index) => store.setUser(`user-${index}`, "control", true)));
  await store.setUser("user-0", "control", false);
  let state = store.snapshot();
  assert.equal(state.viewerUserIds.length, 12);
  assert.equal(state.controllerUserIds.length, 11);
  assert.equal(state.viewerUserIds.includes("user-0"), true);

  await store.setUser("user-0", "view", false);
  state = store.snapshot();
  assert.equal(state.viewerUserIds.includes("user-0"), false);
  assert.equal(state.controllerUserIds.includes("user-0"), false);
});

test("runtime setup merges bootstrap and managed access while selecting a default repo", () => {
  const config = appConfig([project("base", "/tmp/base", true)]);
  const bootstrap = captureBootstrapConfig(config);
  const state: SetupState = {
    version: 1,
    viewerUserIds: ["viewer"],
    controllerUserIds: ["controller"],
    peerBotIds: ["peer"],
    repositories: { second: "/tmp/second" },
    defaultProjectName: "second",
    privateChannelId: "private-room"
  };

  applySetupState(config, bootstrap, state);
  assert.deepEqual([...config.allowedUserIds].sort(), ["bootstrap-user", "controller", "owner", "viewer"]);
  assert.deepEqual([...config.peerBotIds].sort(), ["bootstrap-peer", "peer"]);
  assert.equal(config.coordinationChannelId, "private-room");
  assert.equal(config.projects.find((item) => item.isDefault)?.name, "second");
  assert.equal(isSetupController(state, config.ownerUserId, "owner"), true);
  assert.equal(isSetupController(state, config.ownerUserId, "controller"), true);
  assert.equal(isSetupController(state, config.ownerUserId, "viewer"), false);
});

test("mentions use the setup-selected default when multiple projects exist", () => {
  const projects = [project("first", "/tmp/first"), project("second", "/tmp/second", true)];
  const request = parseMentionRequest("<@123> explain the architecture", "123", projects);
  assert.equal(request.project.name, "second");
});

test("slash schema exposes owner setup and optional default-project commands", () => {
  const setup = commandDefinitions.find((command) => command.name === "setup");
  const ask = commandDefinitions.find((command) => command.name === "ask");
  const doCommand = commandDefinitions.find((command) => command.name === "do");
  const run = commandDefinitions.find((command) => command.name === "run");
  const lab = commandDefinitions.find((command) => command.name === "lab");
  const council = lab?.options?.find((option) => option.name === "council");
  const councilOptions = council && "options" in council ? council.options : [];

  assert.deepEqual(setup?.options?.map((option) => option.name), ["wizard", "doctor", "show", "user", "devbot", "repo", "room"]);
  assert.equal(ask?.options?.find((option) => option.name === "project")?.required, false);
  assert.equal(doCommand?.options?.find((option) => option.name === "project")?.required, false);
  assert.equal(commandDefinitions.some((command) => command.name === "act"), false);
  assert.equal(run?.options?.find((option) => option.name === "project")?.required, false);
  assert.equal(councilOptions?.find((option) => option.name === "project")?.required, false);
});

test("setup wizard renders resumable readiness and native controls", () => {
  const config = appConfig([project("pullprice", "/tmp/pullprice", true)]);
  const emptyState: SetupState = {
    version: 1,
    viewerUserIds: [],
    controllerUserIds: [],
    peerBotIds: [],
    repositories: {}
  };
  const incomplete = setupWizardView(emptyState, config, undefined);
  const incompleteRows = incomplete.components.map((row) => row.toJSON());
  assert.match(incomplete.content, /Required: 1\/2 ready/);
  assert.match(incomplete.content, /TODO  Private room/);
  assert.equal(incompleteRows.length, 4);
  assert.equal(incompleteRows[0]?.components.find((component) => "custom_id" in component && component.custom_id.endsWith(":finish"))?.disabled, true);

  const ready = setupWizardView(emptyState, config, "room-1", true);
  assert.match(ready.content, /Devbot is ready/);
  assert.match(ready.content, /workspace launcher is ready/);
  assert.equal(ready.components[0]?.toJSON().components.find((component) => "custom_id" in component && component.custom_id.endsWith(":finish"))?.disabled, false);
});

test("setup wizard parses stable component IDs and builds a repo modal", () => {
  assert.equal(parseSetupWizardAction("devbot:setup:viewer"), "viewer");
  assert.equal(parseSetupWizardAction("devbot:workroom:close:x"), undefined);
  const modal = setupRepositoryModal().toJSON();
  assert.equal(modal.custom_id, "devbot:setup:repo-modal");
  assert.deepEqual(
    modal.components.flatMap((row) => ("components" in row ? row.components.map((component) => component.custom_id) : [])),
    ["name", "path"]
  );
});

function appConfig(projects: ProjectEntry[]): AppConfig {
  return {
    discordToken: "test-token",
    discordClientId: "client",
    discordGuildId: "guild",
    ownerUserId: "owner",
    autoDeployCommands: true,
    codex: { bin: "codex", model: undefined, sandbox: "read-only", actionSandbox: "workspace-write", timeoutMs: 1000 },
    routing: {
      enabled: false,
      routerModel: undefined,
      routerReasoningEffort: undefined,
      routerTimeoutMs: 1000,
      fastModel: undefined,
      fastReasoningEffort: undefined,
      standardModel: undefined,
      standardReasoningEffort: undefined,
      deepModel: undefined,
      deepReasoningEffort: undefined,
      focusedContextChars: 1000
    },
    allowedUserIds: new Set(["bootstrap-user"]),
    allowedUsernames: new Set(),
    allowedRoleIds: new Set(),
    safeMode: false,
    botIdentity: { owner: "owner", displayName: "devbot" },
    peerBotIds: new Set(["bootstrap-peer"]),
    coordinationChannelId: "bootstrap-room",
    projects,
    scanner: { maxIndexedFileBytes: 1, maxSnippetCharsPerFile: 1, maxPackedContextChars: 1, maxRankedFiles: 1 }
  };
}

function project(name: string, root: string, isDefault = false): ProjectEntry {
  return {
    name,
    root,
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
