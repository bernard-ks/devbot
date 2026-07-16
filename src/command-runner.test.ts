import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatProjectCommandResult,
  resolveProjectCommand,
  resolveProjectCommands,
  runConfiguredProjectCommand
} from "./command-runner.js";
import type { ProjectEntry } from "./types.js";

function project(name: string, root: string): ProjectEntry {
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
}

test("configured command arrays resolve and execute every step in order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-command-array-"));
  await writeFile(path.join(root, "step.mjs"), `
import { appendFile } from "node:fs/promises";
await appendFile("steps.txt", process.argv[2] + "\\n");
console.log("completed " + process.argv[2]);
`);
  const entry = project("demo", root);
  entry.metadata.commands.test = [
    `${shellQuote(process.execPath)} step.mjs first`,
    `${shellQuote(process.execPath)} step.mjs second`
  ];

  assert.equal(resolveProjectCommand(entry, "test"), entry.metadata.commands.test[0]);
  assert.deepEqual(resolveProjectCommands(entry, "test"), entry.metadata.commands.test);
  const result = await runConfiguredProjectCommand(entry, "test", 5_000);

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual((await readFile(path.join(root, "steps.txt"), "utf8")).trim().split("\n"), ["first", "second"]);
  assert.match(result.output, /completed first/);
  assert.match(result.output, /completed second/);
  assert.match(result.command, / && /);
});

test("configured command arrays stop after the first failed step", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-command-failure-"));
  await writeFile(path.join(root, "step.mjs"), `
import { appendFile } from "node:fs/promises";
await appendFile("steps.txt", process.argv[2] + "\\n");
`);
  const entry = project("demo", root);
  entry.metadata.commands.verify = [
    `${shellQuote(process.execPath)} step.mjs first`,
    `${shellQuote(process.execPath)} -e ${shellQuote("process.exit(7)")}`,
    `${shellQuote(process.execPath)} step.mjs never`
  ];

  const result = await runConfiguredProjectCommand(entry, "verify", 5_000);

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal((await readFile(path.join(root, "steps.txt"), "utf8")).trim(), "first");
});

test("configured commands can be cancelled with an AbortSignal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-command-cancel-"));
  const entry = project("demo", root);
  entry.metadata.commands.presets.wait = `${shellQuote(process.execPath)} -e ${shellQuote("setInterval(() => {}, 1000)")}`;
  const controller = new AbortController();
  const cancellation = setTimeout(() => controller.abort(), 150);

  const result = await runConfiguredProjectCommand(entry, "wait", { timeoutMs: 5_000, signal: controller.signal });
  clearTimeout(cancellation);

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.match(result.output, /cancelled/i);
  assert.match(formatProjectCommandResult(result), /`wait` cancelled/);
});

test("configured command timeouts terminate descendant processes", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "devbot-command-tree-"));
  await writeFile(path.join(root, "stubborn.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync("child.ready", "ready");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  await writeFile(path.join(root, "parent.mjs"), `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["stubborn.mjs"], { stdio: "ignore" });
writeFileSync("child.pid", String(child.pid));
setInterval(() => {}, 1000);
`);
  const entry = project("demo", root);
  entry.metadata.commands.presets.tree = `${shellQuote(process.execPath)} parent.mjs`;

  const result = await runConfiguredProjectCommand(entry, "tree", 700);
  const childPid = Number(await readFile(path.join(root, "child.pid"), "utf8"));

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.output, /timed out/i);
  assert.equal(await readFile(path.join(root, "child.ready"), "utf8"), "ready");
  assert.equal(isProcessAlive(childPid), false, `descendant ${childPid} should be gone before the result resolves`);
});

test("configured command execution is bounded and queued runs can be cancelled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-command-concurrency-"));
  await writeFile(path.join(root, "worker.mjs"), `
import { appendFileSync } from "node:fs";
const id = process.argv[2];
appendFileSync("events.log", "start " + id + "\\n");
await new Promise((resolve) => setTimeout(resolve, 350));
appendFileSync("events.log", "end " + id + "\\n");
`);
  const entry = project("demo", root);
  for (const id of ["one", "two", "three", "cancelled"]) {
    entry.metadata.commands.presets[id] = `${shellQuote(process.execPath)} worker.mjs ${id}`;
  }
  const controller = new AbortController();
  const cancellation = setTimeout(() => controller.abort(), 100);

  const [one, two, three, cancelled] = await Promise.all([
    runConfiguredProjectCommand(entry, "one", 5_000),
    runConfiguredProjectCommand(entry, "two", 5_000),
    runConfiguredProjectCommand(entry, "three", 5_000),
    runConfiguredProjectCommand(entry, "cancelled", { timeoutMs: 5_000, signal: controller.signal })
  ]);
  clearTimeout(cancellation);
  assert.equal([one, two, three].every((result) => result.ok), true);
  assert.equal(cancelled.cancelled, true);

  const events = (await readFile(path.join(root, "events.log"), "utf8")).trim().split("\n");
  assert.equal(events.some((event) => event.endsWith(" cancelled")), false);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.startsWith("start ") ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
