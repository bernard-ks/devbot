import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ProjectContextService, parseIncludePatterns } from "./context.js";
import { isWorkStatusQuestion, parseMentionRequest, parseStatusRequest } from "./mention.js";
import { splitDiscordMessage } from "./messages.js";
import { bestNavigationCandidate, detectLocalWebUrlsFromPs, extractScreenshotKeywords } from "./project-screenshot.js";
import { renderStatusImage } from "./status-image.js";
import { TaskStore } from "./task-store.js";
import { formatWorkStatus, parseExternalCodexWork, WorkTracker } from "./work-status.js";

const scanner = {
  maxIndexedFileBytes: 80_000,
  maxSnippetCharsPerFile: 12_000,
  maxPackedContextChars: 120_000,
  maxRankedFiles: 36
};

test("packs ranked text context while ignoring env and node_modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-bot-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "Example service\n");
  await writeFile(path.join(root, ".env"), "OPENAI_API_KEY=should-not-index\n");
  await writeFile(path.join(root, "node_modules", "ignored", "index.js"), "ignored\n");
  await writeFile(path.join(root, "src", "server.ts"), "export function startServer() { return 'server'; }\n");

  const service = new ProjectContextService(scanner);
  const context = await service.pack({ name: "demo", root }, "How does startServer work?");

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
  const context = await service.pack({ name: "demo", root }, "discord bot", ["src/*"]);

  assert.equal(context.files.length, 1);
  assert.equal(context.files[0]?.relativePath, path.join("src", "bot.ts"));
});

test("redacts secret-looking values inside indexed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-bot-"));
  await writeFile(path.join(root, "config.ts"), "const token = 'abcdabcdabcdabcdabcdabcd';\nconst name = 'ok';\n");

  const service = new ProjectContextService(scanner);
  const context = await service.pack({ name: "demo", root }, "token");

  assert.match(context.packedText, /\[REDACTED\]/);
  assert.doesNotMatch(context.packedText, /abcdabcdabcdabcdabcdabcd/);
});

test("parseIncludePatterns handles comma-separated values", () => {
  assert.deepEqual(parseIncludePatterns("src/*, README.md,,*.json"), ["src/*", "README.md", "*.json"]);
});

test("splitDiscordMessage keeps chunks inside the requested limit", () => {
  const chunks = splitDiscordMessage("a ".repeat(3000), 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
});

test("mention status questions route to read-only answer mode", () => {
  const request = parseMentionRequest("<@123> whats the current state of pullprice", "123", [
    { name: "pullprice", root: "/tmp/pullprice" }
  ]);

  assert.equal(request.project.name, "pullprice");
  assert.equal(request.text, "whats the current state of pullprice");
  assert.equal(request.mode, "answer");
});

test("mention action verbs route to action mode", () => {
  const request = parseMentionRequest("<@!123> project:pullprice include:src/* fix the failing tests", "123", [
    { name: "pullprice", root: "/tmp/pullprice" }
  ]);

  assert.equal(request.project.name, "pullprice");
  assert.deepEqual(request.includePatterns, ["src/*"]);
  assert.equal(request.text, "fix the failing tests");
  assert.equal(request.mode, "action");
});

test("mention mode override wins over inferred mode", () => {
  const request = parseMentionRequest("<@123> mode:action whats the current state", "123", [
    { name: "pullprice", root: "/tmp/pullprice" }
  ]);

  assert.equal(request.text, "whats the current state");
  assert.equal(request.mode, "action");
});

test("role mentions can invoke the bot", () => {
  const request = parseMentionRequest("<@&456> what's the status on the web build", "123", [{ name: "pullprice", root: "/tmp/pullprice" }], [
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
    projectName: "pullprice",
    requester: "Shadow.bk",
    text: "run a repo health check"
  });
  work.startedAt = startedAt;

  assert.equal(
    formatWorkStatus(tracker.snapshot(), new Date("2026-06-23T20:01:05.000Z")),
    "Codex dev work currently in progress: 1\n- `pullprice` action via bot for Shadow.bk, running 1m 5s: run a repo health check"
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

test("status image renderer returns a png", async () => {
  const image = await renderStatusImage("Codex dev work currently in progress: 1\n- pullprice session");
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("project screenshot detection finds a running Next dev server for the project", () => {
  const output = [
    "node /Users/bernard/Documents/PullPrice/PullPriceWeb/web/node_modules/.bin/next dev -p 3001",
    "node /Users/bernard/Documents/Other/web/node_modules/.bin/vite --port 5174"
  ].join("\n");

  assert.deepEqual(detectLocalWebUrlsFromPs(output, { name: "pullprice", root: "/Users/bernard/Documents/PullPrice" }), [
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
    "42248 16:54 /Applications/Codex.app/Contents/Resources/cua_node/bin/node --experimental-vm-modules /tmp/kernel.js --session-id abc --working-dir /Users/bernard/Documents/PullPrice",
    "59726 01:02 /Applications/Codex.app/Contents/Resources/codex exec --ephemeral --sandbox workspace-write --cd /Users/bernard/Documents/PullPrice --output-last-message /tmp/answer.txt long prompt text",
    "59727 01:02 /Applications/Codex.app/Contents/Resources/codex exec --cd /Users/bernard/Documents/PullPrice --output-last-message /tmp/devbot-codex-abc/answer.txt bot-owned prompt",
    "99999 00:01 rg PullPrice"
  ].join("\n");

  const work = parseExternalCodexWork(
    output,
    [{ name: "pullprice", root: "/Users/bernard/Documents/PullPrice" }],
    new Date("2026-06-23T20:20:00.000Z")
  );

  assert.equal(work.length, 2);
  assert.equal(work[0]?.projectName, "pullprice");
  assert.equal(work[0]?.source, "local-codex");
  assert.equal(work[0]?.mode, "session");
  assert.equal(work[0]?.pid, 42248);
  assert.equal(work[0]?.text, "local Codex app session");
  assert.equal(work[1]?.mode, "action");
  assert.equal(work[1]?.pid, 59726);
  assert.equal(work.some((item) => item.text.includes("long prompt text")), false);
});
