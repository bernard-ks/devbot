import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ApplicationCommandOptionType, ApplicationCommandType, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { commandDefinitions } from "./commands.js";

const expectedCommands = [
  "projects",
  "setup",
  "status",
  "snip",
  "task",
  "dashboard",
  "studio",
  "inbox",
  "run",
  "review",
  "devbot",
  "peer",
  "lab",
  "refresh",
  "ask",
  "do",
  "ship",
  "Start Devbot workroom",
  "remember",
  "memory"
];

test("complete Discord command surface is unique, bounded, and intentionally counted", () => {
  assert.equal(commandDefinitions.length, 20);
  assert.deepEqual(commandDefinitions.map((command) => command.name), expectedCommands);
  assert.equal(new Set(commandDefinitions.map((command) => `${command.type}:${command.name}`)).size, commandDefinitions.length);

  const slashPaths = commandDefinitions
    .filter((command) => command.type === ApplicationCommandType.ChatInput)
    .flatMap((command) => invocationPaths(command));
  assert.equal(slashPaths.length, 62);
  assert.equal(commandDefinitions.filter((command) => command.type === ApplicationCommandType.Message).length, 1);

  for (const command of commandDefinitions) {
    assert.ok(command.name.length >= 1 && command.name.length <= 32);
    if ("description" in command) assert.ok(command.description.length >= 1 && command.description.length <= 100);
    validateOptions("options" in command ? command.options ?? [] : []);
  }
});

test("every deployed command and subcommand has an interaction dispatch branch", async () => {
  const source = (
    await Promise.all([
      readFile(path.resolve("src/index.ts"), "utf8"),
      readFile(path.resolve("src/interaction-router.ts"), "utf8")
    ])
  ).join("\n");
  const intentionalFallthrough = new Set(["setup room"]);
  for (const command of commandDefinitions) {
    if (command.type === ApplicationCommandType.Message) {
      assert.match(source, /interaction\.isMessageContextMenuCommand\(\)/);
      assert.match(source, /handleAmbientContextMenu\(interaction/);
      continue;
    }
    assert.match(source, new RegExp(`interaction\\.commandName === ["']${escapeRegex(command.name)}["']`), command.name);
    for (const subcommand of subcommandNames(command)) {
      const path = `${command.name} ${subcommand}`;
      const routed = new RegExp(`subcommand\\s*(?:===|!==)\\s*["']${escapeRegex(subcommand)}["']`).test(source);
      assert.ok(routed || intentionalFallthrough.has(path), path);
    }
  }
});

test("destructive repository removal exposes an explicit confirmation field", () => {
  const setup = commandDefinitions.find((command) => command.name === "setup");
  const repo = "options" in (setup ?? {})
    ? setup?.options?.find((option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "repo")
    : undefined;
  const confirm = repo && "options" in repo ? repo.options?.find((option) => option.name === "confirm") : undefined;
  assert.equal(confirm?.required, false);
  assert.match(confirm?.description ?? "", /confirm.*memory deletion/i);
});

test("configured command approval is exposed on run and not unrelated dashboard navigation", () => {
  const run = commandDefinitions.find((command) => command.name === "run");
  const dashboard = commandDefinitions.find((command) => command.name === "dashboard");
  const runOptions = run && "options" in run ? run.options ?? [] : [];
  const dashboardOptions = dashboard && "options" in dashboard ? dashboard.options ?? [] : [];
  assert.ok(runOptions.some((option) => option.name === "confirm" && option.type === ApplicationCommandOptionType.Boolean));
  assert.equal(dashboardOptions.some((option) => option.name === "confirm"), false);
});

test("configured command surfaces share shutdown-aware cancellation tracking", async () => {
  const source = await readFile(path.resolve("src/index.ts"), "utf8");
  assert.match(source, /for \(const controller of activeCommandControllers\)[\s\S]*?controller\.abort/);
  assert.match(source, /runTrackedCommand\(\(signal\) => runConfiguredProjectCommand\(project, command, \{ signal \}\)\)/);
  assert.match(source, /runTrackedValidation\(reviewProject, commandNames\)/);
  assert.match(source, /runTrackedMergeGates\(reviewProject, commandNames\)/);
});

test("help distinguishes backend-confined agent changes from controller-run local validation", async () => {
  const source = await readFile(path.resolve("src/index.ts"), "utf8");
  const start = source.indexOf("function formatDevbotHelp");
  const end = source.indexOf("function parseCommandNames", start);
  assert.ok(start >= 0 && end > start);
  const help = source.slice(start, end);
  assert.match(help, /agentActionsEnabled = controller && actionAvailable && !appConfig\.safeMode/);
  assert.match(help, /localCommandsEnabled = controller && !appConfig\.safeMode/);
  assert.match(help, /Agent-authored project changes/);
  assert.match(help, /Configured local commands/);
});

test("private channel and workroom audience checks include the permission-bypassing guild owner", async () => {
  const source = await readFile(path.resolve("src/index.ts"), "utf8");
  const roomStart = source.indexOf("async function projectRoomAudienceProblem");
  const roomEnd = source.indexOf("async function createOrSyncPrivateRoom", roomStart);
  assert.ok(roomStart >= 0 && roomEnd > roomStart);
  assert.match(source.slice(roomStart, roomEnd), /visibleIds\.add\(channel\.guild\.ownerId\)/);

  const workroomStart = source.indexOf("async function resolveAmbientThreadAudience");
  const workroomEnd = source.indexOf("async function fetchGuildMembersById", workroomStart);
  assert.ok(workroomStart >= 0 && workroomEnd > workroomStart);
  const workroom = source.slice(workroomStart, workroomEnd);
  assert.match(workroom, /candidateIds\.add\(guild\.ownerId\)/);
  assert.match(workroom, /guildMembers\.get\(guild\.ownerId\)/);
  assert.match(workroom, /server owner[\s\S]*outside the Devbot or project allowlist/);
});

test("potentially long task read responses use Discord-safe chunked delivery", async () => {
  const source = await readFile(path.resolve("src/index.ts"), "utf8");
  const start = source.indexOf("async function handleTaskCommand");
  const end = source.indexOf("async function handleTaskPreviewCommand", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.ok((handler.match(/await replyChunked\(/g) ?? []).length >= 4);
  assert.match(handler, /replyChunked\([\s\S]*?formatTaskList/);
  assert.match(handler, /replyChunked\([\s\S]*?formatTaskDetail/);
  assert.match(handler, /replyChunked\([\s\S]*?formatTaskLogs/);
});

test("potentially long preview and lab responses use Discord-safe chunked delivery", async () => {
  const source = await readFile(path.resolve("src/index.ts"), "utf8");
  const previewStart = source.indexOf("async function handleTaskPreviewCommand");
  const previewEnd = source.indexOf("async function handlePreviewControlButton", previewStart);
  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  const previewHandler = source.slice(previewStart, previewEnd);
  assert.match(previewHandler, /replyChunked\([\s\S]*?instances\.map\(formatPreviewInstance\)/);
  assert.match(previewHandler, /replyChunked\(interaction, result\.instance \? formatPreviewInstance/);

  const labStart = source.indexOf("async function handleLabCommand");
  const labEnd = source.indexOf("async function handleWorkroomButton", labStart);
  assert.ok(labStart >= 0 && labEnd > labStart);
  const labHandler = source.slice(labStart, labEnd);
  assert.match(labHandler, /replyChunked\(interaction, formatCollabRecent\(visible\)\)/);
  assert.match(labHandler, /replyChunked\(interaction, \[`Events for/);
  assert.match(labHandler, /replyChunked\(interaction, \["Peer Devbot capability roster"/);
  assert.match(labHandler, /replyChunked\(interaction, \[formatLabHeader\(conversation\)/);
});

test("slash project routing checks bound rooms before dispatch", async () => {
  const source = await readFile(path.resolve("src/index.ts"), "utf8");
  const start = source.indexOf("async function handleCommand");
  const firstCommand = source.indexOf('interaction.commandName === "projects"', start);
  assert.ok(start >= 0 && firstCommand > start);
  assert.match(source.slice(start, firstCommand), /ensureSlashProjectMatchesRoom\(interaction, appConfig\)/);

  const autocompleteStart = source.indexOf("async function handleAutocomplete");
  const autocompleteEnd = source.indexOf("function findProjectFromAutocomplete", autocompleteStart);
  const autocompleteHandler = source.slice(autocompleteStart, autocompleteEnd);
  assert.match(autocompleteHandler, /projectForConfiguredRoom\(interaction\.channelId, appConfig\)/);
  assert.match(autocompleteHandler, /!roomProject \|\| project\.name === roomProject\.name/);
});

test("inbox project filters do not mutate the user's current project", async () => {
  const source = await readFile(path.resolve("src/index.ts"), "utf8");
  const start = source.indexOf("async function handleNeedsMeCommand");
  const end = source.indexOf("async function needsMePayload", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /setSelectedProject/);
});

function invocationPaths(command: RESTPostAPIApplicationCommandsJSONBody): string[] {
  if (command.type !== ApplicationCommandType.ChatInput) return [];
  const subcommands = (command.options ?? []).filter((option) => option.type === ApplicationCommandOptionType.Subcommand);
  return subcommands.length ? subcommands.map((subcommand) => `/${command.name} ${subcommand.name}`) : [`/${command.name}`];
}

function subcommandNames(command: RESTPostAPIApplicationCommandsJSONBody): string[] {
  return command.type === ApplicationCommandType.ChatInput
    ? (command.options ?? [])
        .filter((option) => option.type === ApplicationCommandOptionType.Subcommand)
        .map((option) => option.name)
    : [];
}

function validateOptions(options: readonly unknown[]): void {
  assert.ok(options.length <= 25);
  let optionalSeen = false;
  for (const rawOption of options) {
    const option = rawOption as {
      name: string;
      description?: string | undefined;
      type: number;
      required?: boolean | undefined;
      options?: readonly unknown[] | undefined;
    };
    assert.ok(option.name.length >= 1 && option.name.length <= 32);
    if (option.description !== undefined) assert.ok(option.description.length >= 1 && option.description.length <= 100);
    if (option.type !== ApplicationCommandOptionType.Subcommand && option.type !== ApplicationCommandOptionType.SubcommandGroup) {
      optionalSeen ||= option.required !== true;
      assert.equal(optionalSeen && option.required === true, false, `required option ${option.name} follows an optional option`);
    }
    if (Array.isArray(option.options)) {
      validateOptions(option.options);
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
