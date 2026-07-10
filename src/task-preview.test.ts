import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorizeTaskPreview,
  isPreviewId,
  resolvePreviewCommand,
  TaskPreviewManager,
  type PreviewCommand,
  type StartPreviewInput,
  type TaskPreviewManagerOptions
} from "./task-preview.js";
import { parsePreviewControl } from "./task-controls.js";
import { captureChildIdentity, type ExecutionChildIdentity } from "./task-recovery.js";
import type { ProjectEntry } from "./types.js";

interface Fixture {
  root: string;
  workspace: string;
  ledgerFile: string;
  reportFile: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-preview-test-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    ledgerFile: path.join(root, "state", "previews.json"),
    reportFile: path.join(root, "report.json")
  };
}

async function writeFakeServer(
  fixture: Fixture,
  options: { ignoreSigterm?: boolean; listenDelayMs?: number } = {}
): Promise<string> {
  const script = path.join(fixture.workspace, "fake-server.cjs");
  await writeFile(
    script,
    [
      'const http = require("node:http");',
      'const fs = require("node:fs");',
      "const port = Number(process.env.PORT);",
      'const host = process.env.HOST || "127.0.0.1";',
      options.ignoreSigterm ? 'process.on("SIGTERM", () => {});' : "",
      'const server = http.createServer((request, response) => { response.statusCode = 200; response.end("ok"); });',
      "setTimeout(() => {",
      "  let ledgerReady = false;",
      "  try {",
      `    const ledger = JSON.parse(fs.readFileSync(${JSON.stringify(fixture.ledgerFile)}, "utf8"));`,
      "    ledgerReady = ledger.previews.some((entry) => entry.pid === entry.childIdentity?.pid && entry.tempHome === process.env.HOME);",
      "  } catch {}",
      "  server.listen(port, host, () => {",
      `    fs.writeFileSync(${JSON.stringify(fixture.reportFile)}, JSON.stringify({`,
      "      home: process.env.HOME ?? null,",
      "      discordToken: process.env.DISCORD_TOKEN ?? null,",
      "      host,",
      "      port,",
      "      cwd: process.cwd(),",
      "      ledgerReady",
      "    }));",
      "  });",
      `}, ${options.listenDelayMs ?? 0});`
    ].join("\n"),
    "utf8"
  );
  return script;
}

function makeProject(presets: Record<string, string> = {}): ProjectEntry {
  return {
    name: "demo",
    root: path.join(tmpdir(), "devbot-preview-demo-root"),
    metadata: {
      canonicalName: undefined,
      repoUrl: undefined,
      defaultBranch: "main",
      frontendUrl: undefined,
      backendUrl: undefined,
      ownerBot: undefined,
      aliases: [],
      commands: { test: [], build: [], lint: [], verify: [], presets },
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

function makeManager(fixture: Fixture, overrides: TaskPreviewManagerOptions = {}): TaskPreviewManager {
  return new TaskPreviewManager({
    ledgerFile: fixture.ledgerFile,
    readyTimeoutMs: 15_000,
    pollIntervalMs: 50,
    sigkillDelayMs: 400,
    exitWaitMs: 6_000,
    ...overrides
  });
}

function startInput(fixture: Fixture, command: PreviewCommand, taskId = `task-${randomBytes(4).toString("hex")}`): StartPreviewInput {
  return {
    taskId,
    projectName: "demo",
    branch: "devbot/task/example",
    workspacePath: fixture.workspace,
    command
  };
}

function nodeCommand(script: string): PreviewCommand {
  return { source: "preset", name: "dev", command: `node ${script}` };
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condition was not met in time.");
}

async function respondsOnPort(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    await fetch(`${origin}/`, { method: "GET", redirect: "manual", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function readLedger(fixture: Fixture): Promise<{ version: number; previews: unknown[] }> {
  return JSON.parse(await readFile(fixture.ledgerFile, "utf8")) as { version: number; previews: unknown[] };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

test("starts a preview on a loopback origin with an isolated child environment", async () => {
  const fixture = await createFixture();
  const script = await writeFakeServer(fixture);
  const manager = makeManager(fixture);
  process.env.DISCORD_TOKEN = `fake-token-${randomBytes(12).toString("hex")}`;
  try {
    const result = await manager.start(startInput(fixture, nodeCommand(script)));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const instance = result.instance;
    assert.equal(instance.state, "active");
    assert.ok(isPreviewId(instance.id));
    assert.match(instance.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(instance.origin, `http://127.0.0.1:${instance.port}`);

    const response = await fetch(instance.origin);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");

    const report = JSON.parse(await readFile(fixture.reportFile, "utf8")) as {
      home: string | null;
      discordToken: string | null;
      host: string;
      port: number;
      cwd: string;
      ledgerReady: boolean;
    };
    assert.equal(report.discordToken, null);
    assert.ok(report.home && report.home.includes("devbot-preview-home-"));
    assert.notEqual(report.home, homedir());
    assert.equal(report.host, "127.0.0.1");
    assert.equal(report.port, instance.port);
    assert.equal(await realpath(report.cwd), await realpath(fixture.workspace));
    assert.equal(report.ledgerReady, true, "the configured command must not run before durable worker identity is saved");

    if (process.platform !== "win32") {
      assert.equal(((await stat(fixture.ledgerFile)).mode & 0o777), 0o600);
      assert.equal(((await stat(path.dirname(fixture.ledgerFile))).mode & 0o777), 0o700);
    }
    const ledger = await readLedger(fixture);
    assert.equal(ledger.previews.length, 1);
    const entry = ledger.previews[0] as {
      pid?: number;
      childIdentity?: ExecutionChildIdentity;
      tempHome?: string;
    };
    assert.equal(entry.pid, instance.pid);
    assert.equal(entry.childIdentity?.pid, instance.pid);
    assert.equal(entry.childIdentity?.groupId, instance.pid);
    assert.equal(entry.tempHome, report.home);
    const tempHome = entry.tempHome!;

    const stopped = await manager.stop(instance.id, "requested");
    assert.equal(stopped.ok, true);
    assert.equal(stopped.instance?.state, "stopped");
    assert.ok(instance.pid);
    await waitFor(() => processGone(instance.pid!));
    assert.equal((await readLedger(fixture)).previews.length, 0);
    assert.equal(await pathExists(tempHome), false);
  } finally {
    delete process.env.DISCORD_TOKEN;
    await manager.stopAll("requested");
  }
});

test("refuses to start when the task workspace no longer exists", async () => {
  const fixture = await createFixture();
  const manager = makeManager(fixture);
  const input = startInput(fixture, { source: "preset", name: "dev", command: "node missing.cjs" });
  const result = await manager.start({ ...input, workspacePath: path.join(fixture.root, "gone") });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /no longer exists/);
});

test("fails closed when the preview command exits before serving", async () => {
  const fixture = await createFixture();
  const manager = makeManager(fixture);
  const result = await manager.start(
    startInput(fixture, { source: "preset", name: "dev", command: "definitely-not-a-real-command-xyz" })
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.instance?.state, "failed");
  assert.match(result.message, /exited before it started serving/);
  assert.equal((await readLedger(fixture)).previews.length, 0);
});

test("handles a child spawn error without crashing", async () => {
  const fixture = await createFixture();
  const manager = makeManager(fixture, { shell: path.join(fixture.root, "missing-shell") });
  const result = await manager.start(startInput(fixture, { source: "preset", name: "dev", command: "node whatever.cjs" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.instance?.state, "failed");
  assert.match(result.message, /could not run/);
});

test("enforces the global limit and one preview per task", async () => {
  const fixture = await createFixture();
  const script = await writeFakeServer(fixture);
  const manager = makeManager(fixture, { maxPreviews: 1 });
  try {
    const first = await manager.start(startInput(fixture, nodeCommand(script), "task-limit-a"));
    assert.equal(first.ok, true);

    const duplicate = await manager.start(startInput(fixture, nodeCommand(script), "task-limit-a"));
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.match(duplicate.message, /already has an open preview/);

    const second = await manager.start(startInput(fixture, nodeCommand(script), "task-limit-b"));
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.message, /preview limit \(1\)/);
  } finally {
    await manager.stopAll("requested");
  }
});

test("stop while pending aborts the start and kills the process", async () => {
  const fixture = await createFixture();
  const script = await writeFakeServer(fixture, { listenDelayMs: 60_000 });
  const manager = makeManager(fixture);
  const taskId = "task-pending-stop";
  const startPromise = manager.start(startInput(fixture, nodeCommand(script), taskId));
  await waitFor(() => manager.list(taskId).some((instance) => instance.state === "pending" && instance.pid !== undefined));
  const pending = manager.list(taskId)[0]!;

  const stopped = await manager.stop(pending.id, "requested");
  assert.equal(stopped.ok, true);
  assert.equal(stopped.instance?.state, "stopped");

  const started = await startPromise;
  assert.equal(started.ok, false);
  if (!started.ok) assert.match(started.message, /stopped before it became ready/);
  await waitFor(() => processGone(pending.pid!));
  assert.equal((await readLedger(fixture)).previews.length, 0);
});

test("TTL expiry stops the preview after observing its exit", async () => {
  const fixture = await createFixture();
  const script = await writeFakeServer(fixture);
  const manager = makeManager(fixture, { ttlMs: 1_000 });
  const result = await manager.start(startInput(fixture, nodeCommand(script), "task-ttl"));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  await waitFor(() => manager.status(result.instance.id)?.state === "stopped");
  const expired = manager.status(result.instance.id);
  assert.equal(expired?.stopReason, "expired");
  await waitFor(() => processGone(result.instance.pid!));
  // The TTL stop is timer-driven, so the durable clear lands just after the
  // state flips to stopped: it is gated on the process group being proven
  // quiescent, not on the leader exit alone.
  await waitFor(async () => (await readLedger(fixture)).previews.length === 0);
});

test("escalates SIGTERM to SIGKILL when the preview ignores termination", async () => {
  const fixture = await createFixture();
  const script = await writeFakeServer(fixture, { ignoreSigterm: true });
  const manager = makeManager(fixture, { sigkillDelayMs: 300 });
  const result = await manager.start(startInput(fixture, nodeCommand(script), "task-sigkill"));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const stopped = await manager.stop(result.instance.id, "requested");
  assert.equal(stopped.ok, true);
  assert.equal(stopped.instance?.state, "stopped");
  assert.equal(stopped.instance?.escalatedToSigkill, true);
  await waitFor(() => processGone(result.instance.pid!));
});

test("restart reconciliation kills identifiable orphans and never signals other pids", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process reconciliation");
    return;
  }
  const fixture = await createFixture();
  const script = await writeFakeServer(fixture, { listenDelayMs: 60_000 });
  const orphanId = `prv-${randomBytes(6).toString("hex")}`;
  const orphan = spawn("/bin/sh", ["-c", `node ${script} & wait`, `devbot-preview-${orphanId}`], {
    cwd: fixture.workspace,
    detached: true,
    stdio: "ignore",
    env: { PATH: process.env.PATH ?? "", PORT: "0", HOST: "127.0.0.1", HOME: fixture.root }
  });
  orphan.unref();
  assert.ok(orphan.pid);
  let orphanIdentity: ExecutionChildIdentity | undefined;
  await waitFor(async () => {
    orphanIdentity = await captureChildIdentity(orphan.pid!);
    return orphanIdentity !== undefined && orphanIdentity.groupId === orphan.pid;
  });

  const foreignId = `prv-${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  const orphanHome = await mkdtemp(path.join(tmpdir(), "devbot-preview-home-"));
  const foreignHome = await mkdtemp(path.join(tmpdir(), "devbot-preview-home-"));
  const entry = (id: string, pid: number, command: string, childIdentity: ExecutionChildIdentity, tempHome: string) => ({
    id,
    taskId: "task-orphan",
    projectName: "demo",
    workspacePath: fixture.workspace,
    command,
    marker: `devbot-preview-${id}`,
    port: 4_321,
    origin: "http://127.0.0.1:4321",
    pid,
    childIdentity,
    tempHome,
    createdAt: now,
    expiresAt: now
  });
  await mkdir(path.dirname(fixture.ledgerFile), { recursive: true, mode: 0o700 });
  await writeFile(
    fixture.ledgerFile,
    JSON.stringify({
      version: 1,
      previews: [
        entry(orphanId, orphan.pid!, `node ${script}`, orphanIdentity!, orphanHome),
        entry(
          foreignId,
          process.pid,
          "definitely-not-this-test-process-xyz",
          {
            pid: process.pid,
            groupId: process.pid,
            startedAt: "stale process start time",
            command: "definitely-not-this-test-process-xyz"
          },
          foreignHome
        )
      ]
    }),
    { encoding: "utf8", mode: 0o600 }
  );

  const manager = makeManager(fixture, { sigkillDelayMs: 300 });
  const notes = await manager.reconcile();
  assert.ok(notes.some((note) => note.includes(`Reconciled preview ${orphanId}`)));
  assert.ok(notes.some((note) => note.includes(`no longer belongs to preview ${foreignId}`)));
  await waitFor(() => processGone(orphan.pid!));
  assert.equal((await readLedger(fixture)).previews.length, 0);
  assert.equal(await pathExists(orphanHome), false);
  assert.equal(await pathExists(foreignHome), false);
});

test("restart reconciliation clears gated pre-start state but retains an unverifiable bare pid", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process reconciliation");
    return;
  }
  const fixture = await createFixture();
  const prestartId = `prv-${randomBytes(6).toString("hex")}`;
  const barePidId = `prv-${randomBytes(6).toString("hex")}`;
  const prestartHome = await mkdtemp(path.join(tmpdir(), "devbot-preview-home-"));
  const barePidHome = await mkdtemp(path.join(tmpdir(), "devbot-preview-home-"));
  const now = new Date().toISOString();
  const base = (id: string, tempHome: string) => ({
    id,
    taskId: "task-incomplete-preview",
    projectName: "demo",
    workspacePath: fixture.workspace,
    command: "node fake-server.cjs",
    marker: `devbot-preview-${id}`,
    port: 4_321,
    origin: "http://127.0.0.1:4321",
    tempHome,
    createdAt: now,
    expiresAt: now
  });
  await mkdir(path.dirname(fixture.ledgerFile), { recursive: true, mode: 0o700 });
  await writeFile(
    fixture.ledgerFile,
    JSON.stringify({
      version: 1,
      previews: [base(prestartId, prestartHome), { ...base(barePidId, barePidHome), pid: process.pid }]
    }),
    { encoding: "utf8", mode: 0o600 }
  );

  const manager = makeManager(fixture);
  const notes = await manager.reconcile();
  assert.ok(notes.some((note) => note.includes(`${prestartId} never recorded a worker`)));
  assert.ok(notes.some((note) => note.includes(`${barePidId} has no complete durable process identity`)));
  const remaining = (await readLedger(fixture)).previews as Array<{ id: string }>;
  assert.deepEqual(remaining.map((entry) => entry.id), [barePidId]);
  assert.equal(await pathExists(prestartHome), false);
  assert.equal(await pathExists(barePidHome), true);
  await rm(barePidHome, { force: true, recursive: true });
});

test("reaps a same-group child that outlives its exiting leader before clearing state", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups");
    return;
  }
  const fixture = await createFixture();
  // The orphan child stays in the leader's process group (detached: false) and
  // only starts serving after a delay, so the leader exits while the child is
  // still alive but has not yet claimed the loopback port.
  const orphanChild = path.join(fixture.workspace, "orphan-child.cjs");
  await writeFile(
    orphanChild,
    [
      'const http = require("node:http");',
      'const fs = require("node:fs");',
      "const port = Number(process.env.PORT);",
      'const host = process.env.HOST || "127.0.0.1";',
      'const server = http.createServer((_request, response) => { response.statusCode = 200; response.end("orphan-child"); });',
      "setTimeout(() => {",
      "  server.listen(port, host, () => {",
      `    fs.writeFileSync(${JSON.stringify(fixture.reportFile)}, "listening");`,
      "  });",
      "}, 400);"
    ].join("\n"),
    "utf8"
  );
  // The leader spawns the unref'd same-group child and exits immediately, before
  // the preview can ever be reported ready.
  const leader = path.join(fixture.workspace, "orphan-leader.cjs");
  await writeFile(
    leader,
    [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, [${JSON.stringify(orphanChild)}], {`,
      "  env: process.env,",
      "  detached: false,",
      '  stdio: "ignore"',
      "});",
      "child.unref();",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );

  const manager = makeManager(fixture, { sigkillDelayMs: 300 });
  try {
    const result = await manager.start(startInput(fixture, nodeCommand(leader), "task-orphan-group"));

    // The leader exited without a proven ready preview, so the start fails.
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.instance?.state, "failed");

    // The whole managed group must be reaped: the orphan child is killed before
    // it can bind, so the loopback origin never becomes reachable, and the
    // durable ledger is only cleared once quiescence is proven.
    const origin = result.instance!.origin;
    await waitFor(async () => (await readLedger(fixture)).previews.length === 0);
    const settledAt = Date.now();
    while (Date.now() - settledAt < 1_200) {
      assert.equal(await respondsOnPort(origin), false);
      assert.equal((await readLedger(fixture)).previews.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await manager.stopAll("requested");
  }
});

test("never accepts a foreign server that races for the selected port", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX listener ownership");
    return;
  }
  const fixture = await createFixture();
  // A foreign server owns the selected port before and after the preview runs.
  const foreign = createHttpServer((_request, response) => {
    response.statusCode = 200;
    response.end("foreign-service");
  });
  const foreignPort = await new Promise<number>((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(0, "127.0.0.1", () => {
      const address = foreign.address();
      if (!address || typeof address === "string") {
        reject(new Error("no foreign port"));
        return;
      }
      resolve(address.port);
    });
  });

  // The managed child never binds the port within the window, so the only
  // responder on it is the foreign server that already owns it.
  const script = await writeFakeServer(fixture, { listenDelayMs: 60_000 });
  const manager = makeManager(fixture, {
    readyTimeoutMs: 4_000,
    reservePort: async () => foreignPort
  });
  try {
    // Sanity: the foreign server is genuinely responsive on the raced port.
    assert.equal(await (await fetch(`http://127.0.0.1:${foreignPort}/`)).text(), "foreign-service");

    const result = await manager.start(startInput(fixture, nodeCommand(script), "task-foreign-race"));

    // The foreign listener must never be presented as the task preview.
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.instance?.state, "failed");
    assert.match(result.message, /different process already owns/i);
    assert.equal(manager.status(result.instance!.id)?.state, "failed");
    assert.equal((await readLedger(fixture)).previews.length, 0);
    assert.ok(result.instance?.pid);
    await waitFor(() => processGone(result.instance!.pid!));

    // The manager only stops its own child; the foreign listener is untouched.
    assert.equal(await (await fetch(`http://127.0.0.1:${foreignPort}/`)).text(), "foreign-service");
  } finally {
    await manager.stopAll("requested");
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});

test("resolves only configured presets or allow-listed package scripts", async () => {
  const fixture = await createFixture();

  const none = await resolvePreviewCommand(makeProject(), fixture.workspace);
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.message, /No preview command is configured/);

  await writeFile(
    path.join(fixture.workspace, "package.json"),
    JSON.stringify({ name: "demo", scripts: { "not-allowed": "node evil.js", dev: "node fake-server.cjs" } }),
    "utf8"
  );
  const missingDependencies = await resolvePreviewCommand(makeProject(), fixture.workspace);
  assert.equal(missingDependencies.ok, false);
  if (!missingDependencies.ok) {
    assert.match(missingDependencies.message, /node_modules is missing/);
    assert.match(missingDependencies.message, /does not install/);
  }

  await mkdir(path.join(fixture.workspace, "node_modules"), { recursive: true });
  const inferred = await resolvePreviewCommand(makeProject(), fixture.workspace);
  assert.equal(inferred.ok, true);
  if (inferred.ok) {
    assert.deepEqual(inferred.command, { source: "package-script", name: "dev", command: "npm run dev" });
  }

  const preset = await resolvePreviewCommand(makeProject({ preview: "node fake-server.cjs" }), fixture.workspace);
  assert.equal(preset.ok, true);
  if (preset.ok) {
    assert.deepEqual(preset.command, { source: "preset", name: "preview", command: "node fake-server.cjs" });
  }

  await writeFile(
    path.join(fixture.workspace, "package.json"),
    JSON.stringify({ name: "demo", scripts: { "not-allowed": "node evil.js" } }),
    "utf8"
  );
  const unlisted = await resolvePreviewCommand(makeProject(), fixture.workspace);
  assert.equal(unlisted.ok, false);
});

test("authorization requires a controller to start while the requester may stop or inspect", () => {
  const task = { id: "task-authz", requesterId: "requester" };
  const base = { userId: "requester", controller: false, projectAllowed: true, safeMode: false };

  assert.equal(authorizeTaskPreview("start", task, base).allowed, false);
  assert.equal(authorizeTaskPreview("stop", task, base).allowed, true);
  assert.equal(authorizeTaskPreview("status", task, base).allowed, true);
  assert.equal(authorizeTaskPreview("start", task, { ...base, controller: true }).allowed, true);

  assert.equal(authorizeTaskPreview("start", task, { ...base, projectAllowed: false }).allowed, false);
  assert.equal(authorizeTaskPreview("stop", task, { ...base, projectAllowed: false }).allowed, false);

  const stranger = { ...base, userId: "someone-else" };
  assert.equal(authorizeTaskPreview("start", task, stranger).allowed, false);
  assert.equal(authorizeTaskPreview("stop", task, stranger).allowed, false);
  assert.equal(authorizeTaskPreview("status", task, stranger).allowed, false);
  assert.equal(authorizeTaskPreview("stop", task, { ...stranger, controller: true }).allowed, true);

  const safeMode = { ...base, controller: true, safeMode: true };
  const blockedStart = authorizeTaskPreview("start", task, safeMode);
  assert.equal(blockedStart.allowed, false);
  if (!blockedStart.allowed) assert.match(blockedStart.message, /Safe mode/);
  assert.equal(authorizeTaskPreview("stop", task, safeMode).allowed, true);
  assert.equal(authorizeTaskPreview("status", task, safeMode).allowed, true);

  const anonymousRequester = { id: "task-anon" } as { id: string; requesterId?: string };
  assert.equal(authorizeTaskPreview("stop", anonymousRequester, base).allowed, false);
  assert.equal(authorizeTaskPreview("stop", anonymousRequester, { ...base, controller: true }).allowed, true);
});

test("preview start fails closed when listener ownership is unavailable on Windows", async () => {
  const fixture = await createFixture();
  const manager = makeManager(fixture, { platform: "win32" });
  const result = await manager.start(startInput(fixture, { source: "preset", name: "dev", command: "node server.cjs" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /unavailable on Windows.*ownership/i);
  await assert.rejects(() => readLedger(fixture));
});

test("preview controls parse strictly and expire when unknown", async () => {
  assert.deepEqual(parsePreviewControl("devbot:preview-control:stop:prv-0123456789ab"), {
    action: "stop",
    previewId: "prv-0123456789ab"
  });
  assert.equal(parsePreviewControl("devbot:preview-control:stop:prv-not-hex"), undefined);
  assert.equal(parsePreviewControl("devbot:preview-control:restart:prv-0123456789ab"), undefined);
  assert.equal(parsePreviewControl("devbot:task-control:details:task-abc"), undefined);

  const fixture = await createFixture();
  const manager = makeManager(fixture);
  assert.equal(manager.status("prv-0123456789ab"), undefined);
  const stopped = await manager.stop("prv-0123456789ab", "requested");
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.match(stopped.message, /expired/);
});
