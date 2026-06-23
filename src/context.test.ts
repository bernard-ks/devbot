import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ProjectContextService, parseIncludePatterns } from "./context.js";
import { splitDiscordMessage } from "./messages.js";

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
