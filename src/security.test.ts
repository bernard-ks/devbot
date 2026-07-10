import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { completeCodexPrompt } from "./codex-client.js";
import { runConfiguredProjectCommand } from "./command-runner.js";
import { loadCodexConfig, loadProjectEntry } from "./config.js";
import { ProjectContextService } from "./context.js";
import { isApprovedProjectScreenshotUrl } from "./project-screenshot.js";
import { commandRequiresApproval } from "./safety.js";
import { minimalChildEnvironment, publicErrorMessage, redactSensitiveText } from "./security.js";
import { TaskStore } from "./task-store.js";
import type { ProjectEntry, ScannerConfig } from "./types.js";

const scanner: ScannerConfig = {
  maxIndexedFileBytes: 10_000,
  maxSnippetCharsPerFile: 10_000,
  maxPackedContextChars: 20_000,
  maxRankedFiles: 10
};

function project(name: string, root: string, overrides: Partial<ProjectEntry["metadata"]["policy"]> = {}): ProjectEntry {
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
        approvalRequiredCommands: [],
        ...overrides
      }
    }
  };
}

test("child environments exclude Discord and application credentials", () => {
  const environment = {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex",
    DISCORD_TOKEN: "discord-secret-token-value",
    OPENAI_API_KEY: "sk-example-secret-value-123456",
    DATABASE_URL: "postgres://private"
  };
  assert.deepEqual(minimalChildEnvironment(environment), {
    PATH: "/usr/bin",
    HOME: "/tmp/home"
  });
  assert.deepEqual(minimalChildEnvironment(environment, "codex"), {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex"
  });
});

test("Codex receives prompts over stdin with isolated home and no bot credentials", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "devbot-fake-codex-"));
  const fakeCodex = path.join(root, "fake-codex.mjs");
  const captureFile = path.join(root, "capture.json");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const args = process.argv.slice(2);
const directory = path.dirname(fileURLToPath(import.meta.url));
await writeFile(path.join(directory, "capture.json"), JSON.stringify({ args, stdin, env: { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, DISCORD_TOKEN: process.env.DISCORD_TOKEN } }));
const outputIndex = args.indexOf("--output-last-message");
await writeFile(args[outputIndex + 1], "fake answer");
`);
  await chmod(fakeCodex, 0o700);

  const previousToken = process.env.DISCORD_TOKEN;
  const previousCodexHome = process.env.CODEX_HOME;
  const expectedCodexHome = path.join(root, "auth-home");
  process.env.DISCORD_TOKEN = "discord-secret-never-forward";
  process.env.CODEX_HOME = expectedCodexHome;
  try {
    const answer = await completeCodexPrompt({
      codex: {
        bin: fakeCodex,
        model: undefined,
        sandbox: "read-only",
        actionSandbox: "workspace-write",
        timeoutMs: 20_000
      },
      prompt: "private prompt only on stdin",
      cwd: root,
      sandbox: "read-only",
      skipGitRepoCheck: true
    });
    assert.equal(answer, "fake answer");
  } finally {
    if (previousToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = previousToken;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }

  const capture = JSON.parse(await readFile(captureFile, "utf8")) as {
    args: string[];
    stdin: string;
    env: { HOME?: string; CODEX_HOME?: string; DISCORD_TOKEN?: string };
  };
  assert.equal(capture.stdin, "private prompt only on stdin");
  assert.doesNotMatch(capture.args.join(" "), /private prompt|discord-secret-never-forward/);
  assert.equal(capture.env.DISCORD_TOKEN, undefined);
  assert.equal(capture.env.CODEX_HOME, expectedCodexHome);
  assert.notEqual(capture.env.HOME, process.env.HOME);
});

test("configured project commands receive an empty temporary home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-command-env-"));
  await writeFile(
    path.join(root, "capture.mjs"),
    'import { writeFile } from "node:fs/promises"; await writeFile("capture.json", JSON.stringify({ HOME: process.env.HOME, DISCORD_TOKEN: process.env.DISCORD_TOKEN }));\n'
  );
  const entry = project("demo", root);
  entry.metadata.commands.presets.capture = "node capture.mjs";
  const previousToken = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = "discord-command-secret";
  try {
    const result = await runConfiguredProjectCommand(entry, "capture", 20_000);
    assert.equal(result.ok, true);
  } finally {
    if (previousToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = previousToken;
  }

  const capture = JSON.parse(await readFile(path.join(root, "capture.json"), "utf8")) as {
    HOME: string;
    DISCORD_TOKEN?: string;
  };
  assert.equal(capture.DISCORD_TOKEN, undefined);
  assert.notEqual(capture.HOME, process.env.HOME);
  await assert.rejects(stat(capture.HOME), /ENOENT/);
});

test("Discord-facing text redacts known and patterned credentials", () => {
  const environment = { DISCORD_TOKEN: "known-discord-secret" };
  const redacted = redactSensitiveText(
    "DISCORD_TOKEN=known-discord-secret Authorization: Bearer bearer-secret password=hunter2",
    environment
  );
  assert.doesNotMatch(redacted, /known-discord-secret|bearer-secret|hunter2/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.doesNotMatch(publicErrorMessage(new Error("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz")), /sk-abcdefghijklmnopqrstuvwxyz/);
});

test("Discord Codex sandboxes reject danger-full-access", () => {
  assert.throws(
    () => loadCodexConfig({ CODEX_SANDBOX: "danger-full-access" }),
    /must be read-only/
  );
  assert.throws(
    () => loadCodexConfig({ CODEX_SANDBOX: "read-only", CODEX_ACTION_SANDBOX: "danger-full-access" }),
    /Invalid CODEX_ACTION_SANDBOX/
  );
  assert.equal(
    loadCodexConfig({ CODEX_SANDBOX: "read-only", CODEX_ACTION_SANDBOX: "workspace-write" }).actionSandbox,
    "workspace-write"
  );
});

test("malformed project metadata fails closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-invalid-policy-"));
  await mkdir(path.join(root, ".devbot"));
  await writeFile(path.join(root, ".devbot", "project.json"), "{not json\n");

  assert.throws(() => loadProjectEntry("demo", root), /Unable to load project metadata/);
});

test("project context cache is isolated by the resolved project root", async () => {
  const leftRoot = await mkdtemp(path.join(tmpdir(), "devbot-context-left-"));
  const rightRoot = await mkdtemp(path.join(tmpdir(), "devbot-context-right-"));
  await writeFile(path.join(leftRoot, "left.txt"), "left-only-evidence\n");
  await writeFile(path.join(rightRoot, "right.txt"), "right-only-evidence\n");

  const service = new ProjectContextService(scanner);
  const left = await service.pack(project("same-name", leftRoot), "evidence");
  const right = await service.pack(project("same-name", rightRoot), "evidence");

  assert.match(left.packedText, /left-only-evidence/);
  assert.doesNotMatch(left.packedText, /right-only-evidence/);
  assert.match(right.packedText, /right-only-evidence/);
  assert.doesNotMatch(right.packedText, /left-only-evidence/);
});

test("project context does not follow files outside the project root", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "devbot-context-symlink-"));
  const outside = path.join(await mkdtemp(path.join(tmpdir(), "devbot-context-secret-")), "secret.txt");
  await writeFile(outside, "outside-root-secret\n");
  await symlink(outside, path.join(root, "innocent.txt"));

  const context = await new ProjectContextService(scanner).pack(project("demo", root), "secret");
  assert.doesNotMatch(context.packedText, /outside-root-secret/);
  assert.equal(context.files.length, 0);
});

test("screenshots accept only an approved loopback origin", () => {
  const approved = ["http://localhost:3000"];
  assert.equal(isApprovedProjectScreenshotUrl("http://127.0.0.1:3000/admin?tab=1", approved), true);
  assert.equal(isApprovedProjectScreenshotUrl("http://127.0.0.1:3001/admin", approved), false);
  assert.equal(isApprovedProjectScreenshotUrl("http://169.254.169.254/latest/meta-data", approved), false);
  assert.equal(isApprovedProjectScreenshotUrl("https://example.com", approved), false);
});

test("unclassified project commands require approval", () => {
  const entry = project("demo", "/tmp/demo", { readOnlyCommands: ["lint"], approvalRequiredCommands: ["deploy"] });
  assert.equal(commandRequiresApproval(entry, "lint"), false);
  assert.equal(commandRequiresApproval(entry, "deploy"), true);
  assert.equal(commandRequiresApproval(entry, "unknown"), true);
});

test("proposal approval is bound to the reviewed revision and state is private", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devbot-task-security-"));
  const stateFile = path.join(root, ".devbot", "tasks.json");
  const store = new TaskStore(stateFile);
  const proposal = await store.propose({
    source: "test",
    mode: "action",
    projectName: "demo",
    requester: "security-test",
    text: "Update the parser"
  });
  assert.equal(proposal.proposalRevision, 1);

  const edited = await store.updateProposal(proposal.id, { text: "Update the parser safely", expectedRevision: 1 });
  assert.equal(edited?.proposalRevision, 2);
  assert.equal(await store.begin(proposal.id, { actor: "reviewer", expectedRevision: 1 }), undefined);
  const approved = await store.begin(proposal.id, { actor: "reviewer", expectedRevision: 2 });
  assert.equal(approved?.approvedRevision, 2);

  if (process.platform !== "win32") {
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(stateFile))).mode & 0o777, 0o700);
  }
});
