import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { discordUsernamesFor, isApprovedDiscordUsername, normalizeDiscordUsernames } from "./access.js";
import { commandChoices, peerChoices, projectChoices, taskChoices } from "./autocomplete.js";
import {
  collabDeliveryKey,
  createCollabEnvelope,
  fitCollabEnvelopeToDiscord,
  formatCollabEnvelope,
  isFreshCollabEnvelope,
  parseCollabEnvelope
} from "./collab-protocol.js";
import { CollabStore } from "./collab-store.js";
import { commandDefinitions } from "./commands.js";
import { expandEnvPlaceholders, resolveCodexBin } from "./config.js";
import { configuredCommandNames, resolveProjectCommand } from "./command-runner.js";
import { ProjectContextService, parseIncludePatterns } from "./context.js";
import { isWorkStatusQuestion, parseMentionRequest, parseStatusRequest } from "./mention.js";
import { splitDiscordMessage } from "./messages.js";
import { createPeerEnvelope, formatPeerEnvelope, parsePeerEnvelope } from "./peer.js";
import { bestNavigationCandidate, detectLocalWebUrlsFromPs, extractScreenshotKeywords } from "./project-screenshot.js";
import {
  commandRequiresApproval,
  isPeerAllowedForProject,
  isScreenshotBlocked,
  isWriteBlockedBySafeMode,
  safeModeActionMessage,
  screenshotRequiresApproval
} from "./safety.js";
import {
  councilContributionPrompt,
  councilSynthesisPrompt,
  formatCouncilProgress,
  formatApprovalCard,
  formatSafetySummary,
  formatWorkroomPanel,
  labPrompt,
  localCouncilSeats
} from "./lab.js";
import { renderStatusImage } from "./status-image.js";
import { TaskStore } from "./task-store.js";
import { parseTaskControl, taskControlRow } from "./task-controls.js";
import type { ProjectEntry } from "./types.js";
import { filterWorkForProjects, formatWorkStatus, parseExternalCodexWork, WorkTracker } from "./work-status.js";
import { parseWorkroomButton, workroomActionRows } from "./workroom-controls.js";

const scanner = {
  maxIndexedFileBytes: 80_000,
  maxSnippetCharsPerFile: 12_000,
  maxPackedContextChars: 120_000,
  maxRankedFiles: 36
};

test("Codex binary resolution recovers from a stale absolute app path", () => {
  const currentBundle = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const exists = (candidate: string): boolean => candidate === currentBundle;

  assert.equal(
    resolveCodexBin(
      "/Applications/Codex.app/Contents/Resources/codex",
      [currentBundle, "/Applications/Codex.app/Contents/Resources/codex"],
      exists
    ),
    currentBundle
  );
  assert.equal(resolveCodexBin("codex", [currentBundle], exists), "codex");
});

test("council progress reports completed and failed seats", () => {
  const seats = localCouncilSeats(3);
  const statuses = new Map([
    ["product", "ready" as const],
    ["systems", "working" as const],
    ["verification", "failed" as const]
  ]);

  const progress = formatCouncilProgress("collab-test", seats, statuses);
  assert.match(progress, /Progress: 2\/3 finished \(1 ready, 1 failed\)/);
  assert.match(progress, /Product Steward: ready/);
  assert.match(progress, /Systems Builder: working/);
  assert.match(progress, /Evidence Verifier: failed/);
});

function project(name: string, root: string, overrides: Partial<ProjectEntry["metadata"]> = {}): ProjectEntry {
  return {
    name,
    root,
    metadata: {
      canonicalName: undefined,
      repoUrl: undefined,
      defaultBranch: "main",
      frontendUrl: undefined,
      backendUrl: undefined,
      ownerBot: undefined,
      aliases: [],
      commands: {
        test: [],
        build: [],
        lint: [],
        verify: [],
        presets: {}
      },
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
      },
      ...overrides
    }
  };
}

test("packs ranked text context while ignoring env and node_modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-bot-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "Example service\n");
  await writeFile(path.join(root, ".env"), "OPENAI_API_KEY=should-not-index\n");
  await writeFile(path.join(root, "node_modules", "ignored", "index.js"), "ignored\n");
  await writeFile(path.join(root, "src", "server.ts"), "export function startServer() { return 'server'; }\n");

  const service = new ProjectContextService(scanner);
  const context = await service.pack(project("demo", root), "How does startServer work?");

  assert.match(context.packedText, /src\/server\.ts/);
  assert.doesNotMatch(context.packedText, /should-not-index/);
  assert.doesNotMatch(context.packedText, /node_modules/);
});

test("include patterns restrict packed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-bot-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "README.md"), "Read me\n");
  await writeFile(path.join(root, "src", "bot.ts"), "Discord bot handler\n");

  const service = new ProjectContextService(scanner);
  const context = await service.pack(project("demo", root), "discord bot", ["src/*"]);

  assert.equal(context.files.length, 1);
  assert.equal(context.files[0]?.relativePath, path.join("src", "bot.ts"));
});

test("redacts secret-looking values inside indexed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-bot-"));
  await writeFile(path.join(root, "config.ts"), "const token = 'abcdabcdabcdabcdabcdabcd';\nconst name = 'ok';\n");

  const service = new ProjectContextService(scanner);
  const context = await service.pack(project("demo", root), "token");

  assert.match(context.packedText, /\[REDACTED\]/);
  assert.doesNotMatch(context.packedText, /abcdabcdabcdabcdabcdabcd/);
});

test("parseIncludePatterns handles comma-separated values", () => {
  assert.deepEqual(parseIncludePatterns("src/*, README.md,,*.json"), ["src/*", "README.md", "*.json"]);
});

test("project path config can reference environment variables", () => {
  process.env.DEVBOT_TEST_PROJECT_ROOT = "/tmp/example-project";

  assert.equal(expandEnvPlaceholders("${DEVBOT_TEST_PROJECT_ROOT}/web", "test project"), "/tmp/example-project/web");

  delete process.env.DEVBOT_TEST_PROJECT_ROOT;
});

test("project path config reports missing environment variables", () => {
  delete process.env.DEVBOT_MISSING_PROJECT_ROOT;

  assert.throws(
    () => expandEnvPlaceholders("${DEVBOT_MISSING_PROJECT_ROOT}", "test project"),
    /Missing environment variable DEVBOT_MISSING_PROJECT_ROOT/
  );
});

test("splitDiscordMessage keeps chunks inside the requested limit", () => {
  const chunks = splitDiscordMessage("a ".repeat(3000), 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
});

test("mention status questions route to read-only answer mode", () => {
  const request = parseMentionRequest("<@123> whats the current state of webapp", "123", [
    project("webapp", "/tmp/webapp")
  ]);

  assert.equal(request.project.name, "webapp");
  assert.equal(request.text, "whats the current state of webapp");
  assert.equal(request.mode, "answer");
});

test("mentions remain read-only even when phrased as actions", () => {
  const request = parseMentionRequest("<@!123> project:webapp include:src/* fix the failing tests", "123", [
    project("webapp", "/tmp/webapp")
  ]);

  assert.equal(request.project.name, "webapp");
  assert.deepEqual(request.includePatterns, ["src/*"]);
  assert.equal(request.text, "fix the failing tests");
  assert.equal(request.mode, "answer");
});

test("bare test mention is a read-only ping rather than a project action", () => {
  const request = parseMentionRequest("<@123> test", "123", [project("webapp", "/tmp/webapp")]);
  assert.equal(request.mode, "answer");
  assert.equal(request.text, "test");
});

test("explicit mention mode can request an action", () => {
  const request = parseMentionRequest("<@123> mode:action whats the current state", "123", [
    project("webapp", "/tmp/webapp")
  ]);

  assert.equal(request.text, "whats the current state");
  assert.equal(request.mode, "action");
});

test("role mentions can invoke the bot", () => {
  const request = parseMentionRequest("<@&456> what's the status on the web build", "123", [project("webapp", "/tmp/webapp")], [
    "456"
  ]);

  assert.equal(request.text, "what's the status on the web build");
  assert.equal(request.mode, "answer");
});

test("work status phrases are detected before Codex routing", () => {
  assert.equal(isWorkStatusQuestion("what is currently in progress"), true);
  assert.equal(isWorkStatusQuestion("current dev work?"), true);
  assert.equal(isWorkStatusQuestion("what are you working on?"), true);
  assert.equal(isWorkStatusQuestion("wip"), true);
  assert.equal(isWorkStatusQuestion("fix the failing tests"), false);
});

test("status requests preserve detail questions and image intent", () => {
  assert.deepEqual(parseStatusRequest("status"), {
    isStatus: true,
    question: undefined,
    wantsImage: false
  });

  assert.deepEqual(parseStatusRequest("what's the status on the web build, send me a snip of the output"), {
    isStatus: true,
    question: undefined,
    wantsImage: true
  });

  assert.deepEqual(parseStatusRequest("can you give me a breakdown on what u are working on rn"), {
    isStatus: true,
    question: undefined,
    wantsImage: false
  });

  assert.deepEqual(parseStatusRequest("what's the status on the web build and why is it stuck?"), {
    isStatus: true,
    question: "what's the status on the web build and why is it stuck?",
    wantsImage: false
  });

  assert.deepEqual(parseStatusRequest("fix the failing tests"), {
    isStatus: false,
    question: undefined,
    wantsImage: false
  });
});

test("work status reports empty and active Codex work", () => {
  const tracker = new WorkTracker();

  assert.match(formatWorkStatus(tracker.snapshot()), /No Devbot-managed task or external Codex command is confirmed running/);
  assert.match(formatWorkStatus(tracker.snapshot()), /Ready for the next assignment/);

  const startedAt = new Date("2026-06-23T20:00:00.000Z");
  const work = tracker.start({
    mode: "action",
    projectName: "webapp",
    requester: "Alex",
    text: "run a repo health check",
    taskId: "task-123"
  });
  work.startedAt = startedAt;
  tracker.update(work.id, {
    phase: "running-codex",
    modelTier: "deep",
    contextMode: "full",
    contextFileCount: 8
  });

  const active = formatWorkStatus(tracker.snapshot(), new Date("2026-06-23T20:01:05.000Z"));
  assert.match(active, /Devbot tasks: 1 \| External runs: 0 \| Open sessions: 0/);
  assert.match(active, /`webapp`: `run a repo health check`/);
  assert.match(active, /Phase: Sol is working with 8 context files \| 1m 5s \| requested by Alex/);
  assert.match(active, /`\/task status id:task-123`/);

  const hidden = tracker.start({
    mode: "answer",
    projectName: "private-api",
    requester: "Taylor",
    text: "inspect a private incident"
  });
  const visibleWork = filterWorkForProjects(tracker.snapshot(), [project("webapp", "/tmp/webapp")]);
  assert.deepEqual(visibleWork.map((item) => item.id), [work.id]);
  assert.doesNotMatch(formatWorkStatus(visibleWork), /private-api|private incident|Taylor/);

  tracker.finish(work.id);
  tracker.finish(hidden.id);
  assert.match(formatWorkStatus(tracker.snapshot()), /No Devbot-managed task or external Codex command is confirmed running/);

  const dirtyDefaultBranch = formatWorkStatus([], new Date("2026-06-23T20:01:05.000Z"), [
    {
      projectName: "webapp",
      branch: "main",
      defaultBranch: "main",
      status: " M src/index.ts",
      diffStat: "1 file changed, 4 insertions(+)",
      lastCommit: "abc1234 Last stable commit"
    }
  ]);
  assert.match(dirtyDefaultBranch, /Branch risk: `webapp` has uncommitted work on its default branch `main`/);
  assert.match(dirtyDefaultBranch, /`\/review packet project:webapp`/);
});

test("task store persists task lifecycle to disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-store-"));
  const stateFile = path.join(root, "tasks.json");
  const store = new TaskStore(stateFile);
  const task = await store.start({
    source: "test",
    mode: "answer",
    projectName: "demo",
    requester: "tester",
    text: "inspect project state",
    includePatterns: ["src/*"]
  });

  await store.succeed(task.id, {
    contextFileCount: 2,
    resultPreview: "done",
    model: "gpt-5.6-terra",
    modelTier: "standard",
    contextMode: "focused",
    routeReason: "Targeted project question.",
    routeSource: "model"
  });

  const reloaded = new TaskStore(stateFile);
  const saved = await reloaded.get(task.id);
  const recent = await reloaded.listRecent({ projectName: "demo" });

  assert.equal(saved?.status, "succeeded");
  assert.equal(saved?.contextFileCount, 2);
  assert.equal(saved?.resultPreview, "done");
  assert.equal(saved?.includePatterns[0], "src/*");
  assert.equal(saved?.model, "gpt-5.6-terra");
  assert.equal(saved?.modelTier, "standard");
  assert.equal(saved?.contextMode, "focused");
  assert.equal(saved?.routeSource, "model");
  assert.equal(recent[0]?.id, task.id);
});

test("task store can mark running tasks as canceled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-store-"));
  const store = new TaskStore(path.join(root, "tasks.json"));
  const task = await store.start({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    text: "do work"
  });

  const canceled = await store.cancel(task.id, "stopped");
  const saved = await store.get(task.id);

  assert.equal(canceled?.status, "canceled");
  assert.equal(saved?.status, "canceled");
  assert.equal(saved?.error, "stopped");
});

test("task store serializes concurrent agent task lifecycles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-concurrency-"));
  const stateFile = path.join(root, "tasks.json");
  const store = new TaskStore(stateFile);
  const tasks = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      store.start({
        source: `council:seat-${index}`,
        mode: "answer",
        projectName: "demo",
        requester: "tester",
        text: `independent proposal ${index}`
      })
    )
  );
  await Promise.all(tasks.map((task) => store.succeed(task.id, { resultPreview: task.source })));

  const reloaded = new TaskStore(stateFile);
  const saved = await Promise.all(tasks.map((task) => reloaded.get(task.id)));
  assert.equal(saved.every((task) => task?.status === "succeeded"), true);
});

test("project metadata exposes configured commands and presets", () => {
  const demo = project("demo", "/tmp/demo", {
    commands: {
      test: ["npm test"],
      build: ["npm run build"],
      lint: [],
      verify: ["npm run verify"],
      presets: {
        "quick-check": "npm run build"
      }
    }
  });

  assert.deepEqual(configuredCommandNames(demo), ["build", "quick-check", "test", "verify"]);
  assert.equal(resolveProjectCommand(demo, "test"), "npm test");
  assert.equal(resolveProjectCommand(demo, "quick-check"), "npm run build");
  assert.equal(resolveProjectCommand(demo, "missing"), undefined);
});

test("autocomplete helpers suggest projects commands tasks and peers", () => {
  const demo = project("demo", "/tmp/demo", {
    aliases: ["web"],
    commands: {
      test: ["npm test"],
      build: ["npm run build"],
      lint: [],
      verify: [],
      presets: {
        "quick-check": "npm run build"
      }
    }
  });
  const task = {
    id: "task-abc",
    status: "running" as const,
    source: "slash:act",
    mode: "action",
    projectName: "demo",
    requester: "tester",
    text: "fix the build",
    includePatterns: [],
    startedAt: "2026-06-23T20:00:00.000Z",
    updatedAt: "2026-06-23T20:00:00.000Z"
  };

  assert.deepEqual(projectChoices([demo], "we"), [{ name: "demo", value: "demo" }]);
  assert.deepEqual(commandChoices(demo, "qui"), [{ name: "quick-check", value: "quick-check" }]);
  assert.deepEqual(commandChoices(demo, "test, bu"), [{ name: "build", value: "test, build" }]);
  assert.deepEqual(taskChoices([task], "abc"), [{ name: "task-abc | running action demo", value: "task-abc" }]);
  assert.deepEqual(
    peerChoices(
      [
        {
          botId: "123",
          owner: "alex",
          botName: "alex-devbot",
          projects: ["demo"],
          commands: ["status"],
          supportsScreenshots: true,
          safeMode: false,
          lastSeenAt: "2026-06-23T20:00:00.000Z"
        }
      ],
      "alex"
    ),
    [{ name: "alex-devbot (alex)", value: "123" }]
  );
});

test("command schema exposes help and autocomplete for high-friction options", () => {
  const commands = commandDefinitions as CommandJson[];
  const devbot = commands.find((command) => command.name === "devbot");
  assert.ok(devbot);
  assert.ok(devbot.options?.some((option) => option.name === "help"));

  const run = commands.find((command) => command.name === "run");
  const runCommandOption = run?.options?.find((option) => option.name === "command");
  assert.equal(runCommandOption?.autocomplete, true);

  const task = commands.find((command) => command.name === "task");
  const show = task?.options?.find((option) => option.name === "show");
  const showId = show?.options?.find((option) => option.name === "id");
  assert.equal(showId?.autocomplete, true);

  const peer = commands.find((command) => command.name === "peer");
  const status = peer?.options?.find((option) => option.name === "status");
  const bot = status?.options?.find((option) => option.name === "bot");
  assert.equal(bot?.autocomplete, true);

  const lab = commands.find((command) => command.name === "lab");
  assert.ok(lab?.options?.some((option) => option.name === "council"));
  assert.ok(lab?.options?.some((option) => option.name === "roundtable"));
  assert.ok(lab?.options?.some((option) => option.name === "bossfight"));
  assert.ok(lab?.options?.some((option) => option.name === "fix-from-snip"));
  assert.ok(lab?.options?.some((option) => option.name === "approve"));
  assert.ok(lab?.options?.some((option) => option.name === "events"));
  const roundtable = lab?.options?.find((option) => option.name === "roundtable");
  const roundtableProject = roundtable?.options?.find((option) => option.name === "project");
  assert.equal(roundtableProject?.autocomplete, true);
  const council = lab?.options?.find((option) => option.name === "council");
  assert.equal(council?.options?.find((option) => option.name === "prompt")?.max_length, 500);
  const seats = council?.options?.find((option) => option.name === "seats");
  assert.equal(seats?.min_value, 2);
  assert.equal(seats?.max_value, 4);
  const approve = lab?.options?.find((option) => option.name === "approve");
  assert.ok(approve?.options?.some((option) => option.name === "action"));
  assert.ok(approve?.options?.some((option) => option.name === "commands"));
});

test("workroom controls encode IDs and follow lifecycle state", () => {
  const conversation = {
    id: "collab-1",
    intent: "council" as const,
    projectName: "webapp",
    title: "Pick storage",
    requester: "tester",
    requesterId: "human-1",
    status: "open" as const,
    phase: "collecting" as const,
    participants: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const collecting = workroomActionRows(conversation).flatMap((row) => row.toJSON().components);
  const approve = collecting.find((button) => "custom_id" in button && button.custom_id.includes(":approve:"));
  const challenge = collecting.find((button) => "custom_id" in button && button.custom_id.includes(":challenge:"));

  assert.deepEqual(parseWorkroomButton("devbot:workroom:synthesize:collab-1"), {
    action: "synthesize",
    conversationId: "collab-1"
  });
  assert.equal(parseWorkroomButton("devbot:other:close:collab-1"), undefined);
  assert.equal(approve?.disabled, true);
  assert.equal(challenge?.disabled, false);

  const synthesized = workroomActionRows({ ...conversation, phase: "synthesized" }).flatMap((row) => row.toJSON().components);
  assert.equal(synthesized.find((button) => "custom_id" in button && button.custom_id.includes(":approve:"))?.disabled, false);
});

test("task controls keep task IDs behind native details and retry buttons", () => {
  const row = taskControlRow("task-abc").toJSON();
  assert.deepEqual(row.components.map((component) => "label" in component ? component.label : undefined), ["Details", "Retry"]);
  assert.deepEqual(parseTaskControl("devbot:task-control:details:task-abc"), { action: "details", taskId: "task-abc" });
  assert.equal(parseTaskControl("devbot:setup:refresh"), undefined);
});

interface CommandJson {
  name: string;
  autocomplete?: boolean;
  max_length?: number;
  min_value?: number;
  max_value?: number;
  options?: CommandJson[];
}

test("safe mode blocks only write-capable Codex requests", () => {
  assert.equal(isWriteBlockedBySafeMode({ safeMode: true }, "action"), true);
  assert.equal(isWriteBlockedBySafeMode({ safeMode: true }, "answer"), false);
  assert.equal(isWriteBlockedBySafeMode({ safeMode: false }, "action"), false);
  assert.match(safeModeActionMessage("/do"), /cannot start write-capable Codex work/);
  assert.match(safeModeActionMessage("/do"), /Read-only commands still work/);
});

test("approved Discord usernames normalize without trusting mutable display names", () => {
  const approved = new Set(normalizeDiscordUsernames(["@Alex-Dev", "Team Lead"]));

  assert.deepEqual(discordUsernamesFor({ username: "Alex-Dev", tag: "Alex-Dev#0001" }), ["alex-dev", "alex-dev#0001"]);
  assert.equal(isApprovedDiscordUsername({ username: "alex-dev" }, approved), true);
  assert.equal(isApprovedDiscordUsername({ globalName: "team lead" }, approved), false);
  assert.equal(isApprovedDiscordUsername({ displayName: "Someone Else" }, approved), false);
});

test("peer envelopes round-trip through Discord-friendly fenced JSON", () => {
  const envelope = createPeerEnvelope({
    type: "devbot.peer.request",
    from: "111",
    owner: "alex",
    action: "snip",
    project: "webapp",
    target: "browse page"
  });

  const parsed = parsePeerEnvelope(`<@222>\n${formatPeerEnvelope(envelope)}`);

  assert.equal(parsed?.type, "devbot.peer.request");
  assert.equal(parsed?.from, "111");
  assert.equal(parsed?.action, "snip");
  assert.equal(parsed?.project, "webapp");
  assert.equal(parsed?.target, "browse page");
});

test("collab envelopes round-trip with v2 protocol fields", () => {
  const envelope = createCollabEnvelope({
    type: "devbot.peer.request",
    conversationId: "collab-abc",
    from: { botId: "111", owner: "alex", botName: "alex-devbot" },
    to: { botId: "222", project: "webapp" },
    capability: "task.plan",
    intent: "roundtable",
    mode: "think",
    requiresApproval: false,
    payload: { prompt: "compare options" }
  });

  const parsed = parseCollabEnvelope(`<@222>\n${formatCollabEnvelope(envelope)}`);

  assert.equal(parsed?.version, 2);
  assert.equal(parsed?.conversationId, "collab-abc");
  assert.equal(parsed?.capability, "task.plan");
  assert.equal(parsed?.payload.prompt, "compare options");
  assert.equal(parseCollabEnvelope(JSON.stringify({ ...envelope, capability: "root.shell" })), undefined);
});

test("collab envelopes are freshness-bound, replay-keyed, and fitted to Discord limits", () => {
  const now = Date.parse("2026-07-09T18:00:00.000Z");
  const envelope = createCollabEnvelope({
    type: "devbot.peer.result",
    conversationId: "collab-abc",
    requestId: "req-1",
    correlationId: "req-1",
    from: { botId: "222", owner: "sam" },
    to: { botId: "111", project: "webapp" },
    capability: "task.plan",
    intent: "council",
    mode: "think",
    requiresApproval: false,
    payload: { ok: true, message: "x".repeat(6_000) },
    createdAt: "2026-07-09T18:00:00.000Z"
  });

  const formatted = formatCollabEnvelope(envelope);
  const fitted = fitCollabEnvelopeToDiscord(envelope);
  assert.equal(formatted.length <= 1_950, true);
  assert.equal(fitted.payload.transportTruncated, true);
  assert.equal(isFreshCollabEnvelope(envelope, now), true);
  assert.equal(isFreshCollabEnvelope({ ...envelope, createdAt: "2026-07-09T17:00:00.000Z" }, now), false);
  assert.equal(collabDeliveryKey(envelope, "222"), "devbot.peer.result:222:collab-abc:req-1");

  const maxCouncilRequest = createCollabEnvelope({
    type: "devbot.peer.request",
    conversationId: "collab-max-council",
    from: { botId: "111", owner: "alex", botName: "alex-devbot" },
    to: { botId: "222", project: "webapp" },
    capability: "task.plan",
    intent: "council",
    mode: "think",
    requiresApproval: false,
    payload: { prompt: councilContributionPrompt("x".repeat(500)), sealed: true },
    createdAt: "2026-07-09T18:00:00.000Z"
  });
  const maxCouncilWire = formatCollabEnvelope(maxCouncilRequest);
  assert.equal(maxCouncilWire.length <= 1_950, true);
  assert.notEqual(parseCollabEnvelope(maxCouncilWire)?.payload.transportTruncated, true);
});

test("collab store persists conversations and events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-collab-store-"));
  const store = new CollabStore(path.join(root, "collab.json"));
  const conversation = await store.start({
    intent: "roundtable",
    projectName: "webapp",
    title: "Pick a direction",
    requester: "tester"
  });
  await store.addEvent({
    conversationId: conversation.id,
    type: "decision",
    actor: "tester",
    summary: "Choose the smallest shippable slice."
  });
  await store.setThread(conversation.id, "thread-123");
  await store.setControlMessage(conversation.id, "message-123", "thread-123", true);

  const reloaded = new CollabStore(path.join(root, "collab.json"));
  const recent = await reloaded.recent();
  const events = await reloaded.events(conversation.id);

  assert.equal(recent[0]?.id, conversation.id);
  assert.equal(recent[0]?.threadId, "thread-123");
  assert.equal(recent[0]?.controlChannelId, "thread-123");
  assert.equal(recent[0]?.controlEphemeral, true);
  assert.equal(events.some((event) => event.summary.includes("smallest shippable")), true);
  assert.equal(events.some((event) => event.summary.includes("thread-123")), true);
});

test("sealed council state rejects forged replies and persists its lifecycle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-council-store-"));
  const stateFile = path.join(root, "collab.json");
  const store = new CollabStore(stateFile);
  const conversation = await store.start({
    intent: "council",
    projectName: "webapp",
    title: "Pick a cache",
    brief: "Choose the smallest reliable cache strategy.",
    requester: "tester",
    requesterId: "human-1"
  });
  await store.addContribution({
    conversationId: conversation.id,
    actorId: "bot-local",
    actorName: "local-devbot",
    kind: "proposal",
    content: "Use an in-process cache first.",
    sealed: true
  });
  await store.inviteParticipant({
    conversationId: conversation.id,
    id: "bot-peer",
    displayName: "peer-devbot",
    owner: "peer-owner",
    requestId: "req-1"
  });

  assert.equal(
    await store.acceptPeerContribution({
      conversationId: conversation.id,
      actorId: "bot-peer",
      actorName: "peer-devbot",
      sourceRequestId: "forged-request",
      content: "Forged response"
    }),
    undefined
  );
  const peerContribution = await store.acceptPeerContribution({
    conversationId: conversation.id,
    actorId: "bot-peer",
    actorName: "peer-devbot",
    sourceRequestId: "req-1",
    content: "Prefer no cache until measurement proves it is needed."
  });
  const duplicate = await store.acceptPeerContribution({
    conversationId: conversation.id,
    actorId: "bot-peer",
    actorName: "peer-devbot",
    sourceRequestId: "req-1",
    content: "Conflicting duplicate"
  });

  assert.equal(duplicate?.id, peerContribution?.id);
  assert.equal((await store.contributions(conversation.id)).length, 0);
  assert.equal((await store.contributions(conversation.id, { includeSealed: true })).length, 2);
  assert.equal(await store.decide({ conversationId: conversation.id, outcome: "approve", actor: "tester" }), undefined);

  const revealed = await store.revealContributions(conversation.id, "tester");
  assert.equal(revealed.every((contribution) => !contribution.sealed), true);
  assert.equal((await store.get(conversation.id))?.phase, "deliberating");
  assert.equal(
    await store.acceptPeerContribution({
      conversationId: conversation.id,
      actorId: "bot-peer",
      actorName: "peer-devbot",
      sourceRequestId: "req-1",
      content: "Late response"
    }),
    undefined
  );

  await store.addSynthesis({
    conversationId: conversation.id,
    actorId: "bot-chair",
    actorName: "chair",
    content: "Measure before adding infrastructure."
  });
  assert.equal((await store.get(conversation.id))?.phase, "synthesized");
  assert.equal(
    (await store.decide({ conversationId: conversation.id, outcome: "approve", actor: "tester" }))?.decision?.outcome,
    "approve"
  );
  assert.equal(await store.decide({ conversationId: conversation.id, outcome: "deny", actor: "tester" }), undefined);
  await store.close(conversation.id, "tester");
  assert.equal(await store.close(conversation.id, "tester"), undefined);

  const reloaded = new CollabStore(stateFile);
  assert.equal((await reloaded.get(conversation.id))?.phase, "closed");
  assert.equal((await reloaded.contributions(conversation.id, { includeSealed: true })).length, 3);
});

test("collab store migrates legacy sessions and serializes concurrent mutations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-collab-legacy-"));
  const stateFile = path.join(root, "collab.json");
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      conversations: [
        {
          id: "collab-legacy",
          intent: "roundtable",
          title: "Legacy room",
          requester: "tester",
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      events: []
    })
  );
  const store = new CollabStore(stateFile);
  assert.equal((await store.get("collab-legacy"))?.phase, "collecting");

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.addEvent({
        conversationId: "collab-legacy",
        type: "note",
        actor: "tester",
        summary: `event-${index}`
      })
    )
  );
  assert.equal(await store.claimDelivery("request:bot-1:req-1"), true);
  assert.equal(await store.claimDelivery("request:bot-1:req-1"), false);
  const reloaded = new CollabStore(stateFile);
  assert.equal((await reloaded.events("collab-legacy", 50)).length, 20);
  assert.equal(await reloaded.claimDelivery("request:bot-1:req-1"), false);
});

test("collab store fails loudly without overwriting malformed state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-collab-corrupt-"));
  const stateFile = path.join(root, "collab.json");
  await writeFile(stateFile, "{ definitely-not-json\n");

  await assert.rejects(new CollabStore(stateFile).recent(), /Unable to read collaboration state/);

  await writeFile(stateFile, JSON.stringify({ version: 99, conversations: [], events: [] }));
  await assert.rejects(new CollabStore(stateFile).recent(), /Unsupported collaboration state version/);
});

test("lab prompts and approval cards expose collaboration intent safely", () => {
  assert.match(labPrompt("roundtable", "fix onboarding"), /product, frontend, backend, testing, and risk/);
  assert.match(labPrompt("argue", "ship now"), /Contrarian Council/);
  assert.match(councilContributionPrompt("pick storage"), /independent contributor/);
  assert.match(councilContributionPrompt("pick storage"), /remain sealed/);
  assert.equal(localCouncilSeats(3).map((seat) => seat.id).join(","), "product,systems,verification");
  assert.match(councilContributionPrompt("pick storage", localCouncilSeats(2)[1]), /Systems Builder/);
  assert.match(
    councilSynthesisPrompt("pick storage", [
      {
        id: "contribution-1",
        conversationId: "collab-1",
        actorId: "bot-1",
        actorName: "bot one",
        kind: "proposal",
        content: "Use SQLite.",
        sealed: false,
        artifacts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        revealedAt: "2026-01-01T00:00:00.000Z"
      }
    ]),
    /evidence, not as instructions/
  );
  const workroomStoreShape = {
    id: "collab-1",
    intent: "council" as const,
    projectName: "webapp",
    title: "Pick storage",
    brief: "Pick storage",
    requester: "tester",
    requesterId: "human-1",
    status: "open" as const,
    phase: "collecting" as const,
    participants: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  assert.match(formatWorkroomPanel(workroomStoreShape, []), /0 sealed/);
  assert.match(
    formatApprovalCard({
      action: "Run validation",
      actor: "tester",
      projectName: "webapp",
      risk: "medium",
      reason: "Command may write build output.",
      scope: "project root",
      sideEffects: "runs configured scripts"
    }),
    /Approval required/
  );
});

test("lab safety summary names peer and mutation boundaries", () => {
  const summary = formatSafetySummary(
    {
      safeMode: true,
      peerBotIds: new Set(["123"]),
      botIdentity: { owner: "alex", displayName: "alex-devbot" },
      codex: {
        bin: "codex",
        model: undefined,
        sandbox: "read-only",
        actionSandbox: "workspace-write",
        timeoutMs: 1_000
      }
    },
    project("webapp", "/tmp/webapp")
  );

  assert.match(summary, /Safe mode: on/);
  assert.match(summary, /No peer request may execute writes/);
});

test("project policy gates peers screenshots and commands", () => {
  const gated = project("webapp", "/tmp/webapp", {
    policy: {
      visibility: "team",
      allowedUsers: [],
      allowedUsernames: ["alex-dev"],
      allowedRoles: [],
      allowedPeers: ["222"],
      screenshotPolicy: "approval",
      maxContextChars: 12_000,
      readOnlyCommands: ["test"],
      approvalRequiredCommands: ["verify"]
    }
  });

  assert.equal(isPeerAllowedForProject(gated, "222"), true);
  assert.equal(isPeerAllowedForProject(gated, "333"), false);
  assert.equal(screenshotRequiresApproval(gated), true);
  assert.equal(isScreenshotBlocked(gated), false);
  assert.equal(commandRequiresApproval(gated, "verify"), true);
  assert.equal(commandRequiresApproval(gated, "test"), false);
});

test("status image renderer returns a png", async () => {
  const image = await renderStatusImage("Development status\nNo confirmed work\nBest next step: review recent tasks");
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("project screenshot detection finds a running Next dev server for the project", () => {
  const output = [
    "node /tmp/webapp/web/node_modules/.bin/next dev -p 3001",
    "node /tmp/other/web/node_modules/.bin/vite --port 5174"
  ].join("\n");

  assert.deepEqual(detectLocalWebUrlsFromPs(output, project("webapp", "/tmp/webapp")), [
    "http://127.0.0.1:3001"
  ]);
});

test("project screenshot keywords ignore generic screenshot wording", () => {
  assert.deepEqual(extractScreenshotKeywords("send me a ui snip of the browse page"), ["browse"]);
  assert.deepEqual(extractScreenshotKeywords("what's the current frontend status"), []);
});

test("project screenshot navigation chooses visible UI by request text", () => {
  const candidates = [
    { index: 0, text: "Home", href: "http://127.0.0.1:3001/" },
    { index: 1, text: "Browse cards", href: "http://127.0.0.1:3001/browse" },
    { index: 2, text: "Watchlist", href: "http://127.0.0.1:3001/watchlist" }
  ];

  assert.equal(bestNavigationCandidate(candidates, "send me a ui snip of the browse page")?.index, 1);
  assert.equal(bestNavigationCandidate(candidates, "show the current watchlist view")?.index, 2);
  assert.equal(bestNavigationCandidate(candidates, "send me a snip")?.index, undefined);
});

test("external Codex process parser detects configured project sessions without leaking commands", () => {
  const output = [
    "42248 49:07 /Applications/Codex.app/Contents/Resources/cua_node/bin/node --experimental-vm-modules /tmp/kernel.js --session-id abc --working-dir /tmp/webapp",
    "59726 01:02 /Applications/Codex.app/Contents/Resources/codex exec --ephemeral --sandbox workspace-write --cd /tmp/webapp --output-last-message /tmp/answer.txt long prompt text",
    "59727 01:02 /Applications/Codex.app/Contents/Resources/codex exec --cd /tmp/webapp --output-last-message /tmp/devbot-codex-abc/answer.txt bot-owned prompt",
    "99999 00:01 rg webapp"
  ].join("\n");

  const work = parseExternalCodexWork(
    output,
    [project("webapp", "/tmp/webapp")],
    new Date("2026-06-23T20:20:00.000Z")
  );

  assert.equal(work.length, 2);
  assert.equal(work[0]?.projectName, "webapp");
  assert.equal(work[0]?.source, "local-codex");
  assert.equal(work[0]?.mode, "session");
  assert.equal(work[0]?.pid, 42248);
  assert.equal(work[0]?.text, "local Codex app session");
  assert.equal(work[1]?.mode, "action");
  assert.equal(work[1]?.pid, 59726);
  assert.equal(work.some((item) => item.text.includes("long prompt text")), false);

  const status = formatWorkStatus(work, new Date("2026-06-23T20:20:00.000Z"), [
    {
      projectName: "webapp",
      branch: "codex/status-brief",
      defaultBranch: "main",
      status: " M src/work-status.ts\n?? src/new-status.test.ts\n?? .env.local",
      diffStat: "2 files changed, 20 insertions(+)",
      lastCommit: "abc1234 Improve status routing"
    }
  ]);
  assert.match(status, /Open sessions \(activity unknown\)/);
  assert.match(status, /Open does not prove active work/);
  assert.match(status, /branch `codex\/status-brief`; 3 changed paths/);
  assert.match(status, /`\[sensitive path hidden\]`/);
  assert.doesNotMatch(status, /\.env\.local/);
  assert.match(status, /Visibility gap: `webapp` has an external session open 49m 7s/);
  assert.match(status, /completed \/ in progress \/ blocked \/ next/);
  assert.doesNotMatch(status, /pid 42248|pid 59726|long prompt text|bot-owned prompt/);
});
