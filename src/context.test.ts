import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ProjectContextService, parseIncludePatterns } from "./context.js";
import { isWorkStatusQuestion, parseMentionRequest } from "./mention.js";
import { splitDiscordMessage } from "./messages.js";
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

test("work status phrases are detected before Codex routing", () => {
  assert.equal(isWorkStatusQuestion("what is currently in progress"), true);
  assert.equal(isWorkStatusQuestion("current dev work?"), true);
  assert.equal(isWorkStatusQuestion("wip"), true);
  assert.equal(isWorkStatusQuestion("fix the failing tests"), false);
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
