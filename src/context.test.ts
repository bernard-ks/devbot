import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { commandChoices, peerChoices, projectChoices, taskChoices } from "./autocomplete.js";
import { createCollabEnvelope, formatCollabEnvelope, parseCollabEnvelope } from "./collab-protocol.js";
import { CollabStore } from "./collab-store.js";
import { commandDefinitions } from "./commands.js";
import { expandEnvPlaceholders } from "./config.js";
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
import { formatApprovalCard, formatSafetySummary, labPrompt } from "./lab.js";
import { renderStatusImage } from "./status-image.js";
import { TaskStore } from "./task-store.js";
import type { ProjectEntry } from "./types.js";
import { formatWorkStatus, parseExternalCodexWork, WorkTracker } from "./work-status.js";

const scanner = {
  maxIndexedFileBytes: 80_000,
  maxSnippetCharsPerFile: 12_000,
  maxPackedContextChars: 120_000,
  maxRankedFiles: 36
};

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

test("mention action verbs route to action mode", () => {
  const request = parseMentionRequest("<@!123> project:webapp include:src/* fix the failing tests", "123", [
    project("webapp", "/tmp/webapp")
  ]);

  assert.equal(request.project.name, "webapp");
  assert.deepEqual(request.includePatterns, ["src/*"]);
  assert.equal(request.text, "fix the failing tests");
  assert.equal(request.mode, "action");
});

test("mention mode override wins over inferred mode", () => {
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
    question: "what's the status on the web build, send me a snip of the output",
    wantsImage: true
  });

  assert.deepEqual(parseStatusRequest("fix the failing tests"), {
    isStatus: false,
    question: undefined,
    wantsImage: false
  });
});

test("work status reports empty and active Codex work", () => {
  const tracker = new WorkTracker();

  assert.equal(formatWorkStatus(tracker.snapshot()), "No Codex dev work is currently in progress.");

  const startedAt = new Date("2026-06-23T20:00:00.000Z");
  const work = tracker.start({
    mode: "action",
    projectName: "webapp",
    requester: "Alex",
    text: "run a repo health check"
  });
  work.startedAt = startedAt;

  assert.equal(
    formatWorkStatus(tracker.snapshot(), new Date("2026-06-23T20:01:05.000Z")),
    "Codex dev work currently in progress: 1\n- `webapp` action via bot for Alex, running 1m 5s: run a repo health check"
  );

  tracker.finish(work.id);
  assert.equal(formatWorkStatus(tracker.snapshot()), "No Codex dev work is currently in progress.");
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

  await store.succeed(task.id, { contextFileCount: 2, resultPreview: "done" });

  const reloaded = new TaskStore(stateFile);
  const saved = await reloaded.get(task.id);
  const recent = await reloaded.listRecent({ projectName: "demo" });

  assert.equal(saved?.status, "succeeded");
  assert.equal(saved?.contextFileCount, 2);
  assert.equal(saved?.resultPreview, "done");
  assert.equal(saved?.includePatterns[0], "src/*");
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
  assert.ok(lab?.options?.some((option) => option.name === "roundtable"));
  assert.ok(lab?.options?.some((option) => option.name === "bossfight"));
  assert.ok(lab?.options?.some((option) => option.name === "fix-from-snip"));
  assert.ok(lab?.options?.some((option) => option.name === "approve"));
  assert.ok(lab?.options?.some((option) => option.name === "events"));
  const roundtable = lab?.options?.find((option) => option.name === "roundtable");
  const roundtableProject = roundtable?.options?.find((option) => option.name === "project");
  assert.equal(roundtableProject?.autocomplete, true);
  const approve = lab?.options?.find((option) => option.name === "approve");
  assert.ok(approve?.options?.some((option) => option.name === "action"));
  assert.ok(approve?.options?.some((option) => option.name === "commands"));
});

interface CommandJson {
  name: string;
  autocomplete?: boolean;
  options?: CommandJson[];
}

test("safe mode blocks only write-capable Codex requests", () => {
  assert.equal(isWriteBlockedBySafeMode({ safeMode: true }, "action"), true);
  assert.equal(isWriteBlockedBySafeMode({ safeMode: true }, "answer"), false);
  assert.equal(isWriteBlockedBySafeMode({ safeMode: false }, "action"), false);
  assert.match(safeModeActionMessage("/act"), /cannot start write-capable Codex work/);
  assert.match(safeModeActionMessage("/act"), /Read-only commands still work/);
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

  const reloaded = new CollabStore(path.join(root, "collab.json"));
  const recent = await reloaded.recent();
  const events = await reloaded.events(conversation.id);

  assert.equal(recent[0]?.id, conversation.id);
  assert.equal(recent[0]?.threadId, "thread-123");
  assert.equal(events.some((event) => event.summary.includes("smallest shippable")), true);
  assert.equal(events.some((event) => event.summary.includes("thread-123")), true);
});

test("lab prompts and approval cards expose collaboration intent safely", () => {
  assert.match(labPrompt("roundtable", "fix onboarding"), /product, frontend, backend, testing, and risk/);
  assert.match(labPrompt("argue", "ship now"), /Contrarian Council/);
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
  const image = await renderStatusImage("Codex dev work currently in progress: 1\n- webapp session");
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
    "42248 16:54 /Applications/Codex.app/Contents/Resources/cua_node/bin/node --experimental-vm-modules /tmp/kernel.js --session-id abc --working-dir /tmp/webapp",
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
});
