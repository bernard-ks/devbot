import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKEND_ORDER,
  clearDetectionCache,
  createClaudeBackend,
  createCodexBackend,
  createGeminiBackend,
  createOpencodeBackend,
  normalizeBackendId,
  parseVersionOutput,
  selectBackendId,
  setActiveBackendId,
  getActiveBackendId,
  type BuildCommandOptions
} from "./agent-backend.js";
import type { CodexConfig } from "./types.js";

const codex: CodexConfig = {
  bin: "codex",
  model: "gpt-5.6-sol",
  sandbox: "read-only",
  actionSandbox: "workspace-write",
  timeoutMs: 180_000
};

function answerOptions(overrides: Partial<BuildCommandOptions> = {}): BuildCommandOptions {
  return { prompt: "explain this", cwd: "/tmp/project", timeoutMs: 180_000, ...overrides };
}

const CODEX_HARDENING = [
  "--ephemeral",
  "--strict-config",
  "--sandbox",
] as const;

const CODEX_DISABLES = [
  "--ignore-user-config",
  "--ignore-rules",
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "--disable",
  "hooks",
  "--disable",
  "browser_use",
  "--disable",
  "computer_use",
  "--disable",
  "in_app_browser",
  "--disable",
  "image_generation",
  "--disable",
  "multi_agent",
  "--config",
  "allow_login_shell=false",
  "--config",
  "project_doc_max_bytes=0",
  "--config",
  'web_search="disabled"',
  "--config",
  "sandbox_workspace_write.network_access=false",
  "--config",
  'shell_environment_policy.inherit="core"',
  "--config",
  'shell_environment_policy.include_only=["PATH","HOME","USER","LOGNAME","SHELL","TMPDIR","TEMP","TMP","LANG","LC_*","TERM","COLORTERM","NO_COLOR","FORCE_COLOR","CI"]',
] as const;

test("codex backend answer command hardens flags and pipes the prompt over stdin", () => {
  const backend = createCodexBackend(codex);
  const spec = backend.buildAnswerCommand(answerOptions({ outputFile: "/tmp/out/answer.txt" }));
  assert.equal(spec.bin, "codex");
  assert.deepEqual(spec.args, [
    "--ask-for-approval",
    "never",
    "exec",
    "--model",
    "gpt-5.6-sol",
    ...CODEX_HARDENING,
    "read-only",
    ...CODEX_DISABLES,
    "--cd",
    "/tmp/project",
    "--output-last-message",
    "/tmp/out/answer.txt",
    "-"
  ]);
  assert.equal(spec.stdin, "explain this");
  assert.equal(spec.outputFile, "/tmp/out/answer.txt");
});

test("codex backend action command uses the workspace-write sandbox and reasoning override order", () => {
  const backend = createCodexBackend(codex);
  const spec = backend.buildActionCommand(
    answerOptions({ outputFile: "/tmp/out/answer.txt", model: "gpt-5.6-terra", reasoningEffort: "high" })
  );
  assert.deepEqual(spec.args, [
    "--ask-for-approval",
    "never",
    "exec",
    "--config",
    'model_reasoning_effort="high"',
    "--model",
    "gpt-5.6-terra",
    ...CODEX_HARDENING,
    "workspace-write",
    ...CODEX_DISABLES,
    "--cd",
    "/tmp/project",
    "--output-last-message",
    "/tmp/out/answer.txt",
    "-"
  ]);
});

test("codex backend honors explicit sandbox override and skip-git-repo-check for router preflight", () => {
  const backend = createCodexBackend(codex);
  const spec = backend.buildAnswerCommand(
    answerOptions({ outputFile: "/tmp/out/answer.txt", sandbox: "read-only", skipGitRepoCheck: true, model: "router" })
  );
  assert.deepEqual(spec.args, [
    "--ask-for-approval",
    "never",
    "exec",
    "--model",
    "router",
    ...CODEX_HARDENING,
    "read-only",
    ...CODEX_DISABLES,
    "--cd",
    "/tmp/project",
    "--output-last-message",
    "/tmp/out/answer.txt",
    "--skip-git-repo-check",
    "-"
  ]);
});

test("claude backend hardens answers with safe-mode, plan permissions, and a read-only tool allow list", () => {
  const backend = createClaudeBackend({});
  const answer = backend.buildAnswerCommand(answerOptions({ runtimeDir: "/tmp/run" }));
  assert.equal(backend.experimental, false);
  assert.equal(answer.bin, "claude");
  assert.equal(answer.outputFile, undefined);
  assert.deepEqual(answer.args, [
    "--print",
    "--safe-mode",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
    "--disallowedTools",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "Bash",
    "WebFetch",
    "WebSearch"
  ]);
});

test("claude backend requires an isolated runtime home and fails closed for action mode", () => {
  const backend = createClaudeBackend({});
  assert.throws(() => backend.buildAnswerCommand(answerOptions()), /runtime home/i);
  assert.throws(() => backend.buildActionCommand(answerOptions({ runtimeDir: "/tmp/run" })), /confine|task workspace/i);
});

test("claude backend declares an honest capability contract: read-only answers, no confined actions", () => {
  const backend = createClaudeBackend({});
  assert.deepEqual(backend.capabilities, {
    minimalEnvironment: true,
    isolatesUserConfig: true,
    constrainsNetwork: false,
    enforcesAnswerReadOnly: true,
    confinesActionWorkspace: false,
    supportsCancellation: true,
    promptTransport: "stdin",
    outputTransport: "stdout",
    acceptsImageInput: false
  });
});

test("claude backend runs with an isolated HOME while auth resolves through the real config dir", () => {
  const backend = createClaudeBackend({ HOME: "/home/dev" });
  const spec = backend.buildAnswerCommand(answerOptions({ runtimeDir: "/tmp/run" }));
  assert.equal(spec.env.HOME, "/tmp/run");
  assert.equal(spec.env.USERPROFILE, "/tmp/run");
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, "/home/dev/.claude");
  const withConfigDir = createClaudeBackend({ HOME: "/home/dev", CLAUDE_CONFIG_DIR: "/opt/claude-config" });
  assert.equal(withConfigDir.buildAnswerCommand(answerOptions({ runtimeDir: "/tmp/run" })).env.CLAUDE_CONFIG_DIR, "/opt/claude-config");
});

test("claude backend maps configured tier models to the model flag and ignores codex model strings", () => {
  const backend = createClaudeBackend({ DEVBOT_CLAUDE_DEEP_MODEL: "opus", DEVBOT_CLAUDE_MODEL: "sonnet" });
  const deep = backend.buildAnswerCommand(answerOptions({ tier: "deep", model: "gpt-5.6-sol", runtimeDir: "/tmp/run" }));
  assert.deepEqual(deep.args.slice(-2), ["--model", "opus"]);
  const fast = backend.buildAnswerCommand(answerOptions({ tier: "fast", runtimeDir: "/tmp/run" }));
  assert.deepEqual(fast.args.slice(-2), ["--model", "sonnet"]);
  const untyped = backend.buildAnswerCommand(answerOptions({ runtimeDir: "/tmp/run" }));
  assert.equal(untyped.args.includes("--model"), false);
});

test("gemini backend is detection-only: both modes fail closed and no spawn spec exists", () => {
  const backend = createGeminiBackend({});
  assert.equal(backend.experimental, true);
  assert.equal(backend.capabilities.enforcesAnswerReadOnly, false);
  assert.equal(backend.capabilities.confinesActionWorkspace, false);
  assert.throws(() => backend.buildAnswerCommand(answerOptions()), /read-only/i);
  assert.throws(() => backend.buildActionCommand(answerOptions()), /confine|task workspace/i);
});

test("opencode backend is detection-only: both modes fail closed and no spawn spec exists", () => {
  const backend = createOpencodeBackend({});
  assert.equal(backend.experimental, true);
  assert.equal(backend.capabilities.enforcesAnswerReadOnly, false);
  assert.equal(backend.capabilities.confinesActionWorkspace, false);
  assert.throws(() => backend.buildAnswerCommand(answerOptions()), /read-only/i);
  assert.throws(() => backend.buildActionCommand(answerOptions()), /confine|task workspace/i);
});

test("no backend places the prompt in argv; every backend delivers it off-argv", () => {
  const secret = "top-secret-prompt-body-42";
  const opts = answerOptions({ prompt: secret, outputFile: "/tmp/out/answer.txt", runtimeDir: "/tmp/run" });
  const specs = [
    createCodexBackend(codex).buildAnswerCommand(opts),
    createCodexBackend(codex).buildActionCommand(opts),
    createClaudeBackend({}).buildAnswerCommand(opts)
  ];
  for (const spec of specs) {
    assert.equal(spec.args.includes(secret), false, `prompt must not appear in argv for ${spec.bin}`);
    assert.equal(spec.args.some((arg) => arg.includes(secret)), false, `no argv token may embed the prompt for ${spec.bin}`);
    assert.equal(spec.stdin, secret, `prompt must be delivered over stdin for ${spec.bin}`);
  }
});

test("claude child environment admits only exact documented keys, never Devbot secrets or prefix lookalikes", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    DISCORD_TOKEN: "bot-token-should-never-leak",
    DEVBOT_OWNER_USER_ID: "123",
    APPLICATION_SECRET: "nope",
    ANTHROPIC_API_KEY: "sk-ant-should-reach-claude",
    ANTHROPIC_AUTH_TOKEN: "oat-should-reach-claude",
    ANTHROPIC_INTERNAL_SECRET: "prefix-lookalike-must-not-cross",
    ANTHROPIC_ADMIN_KEY: "prefix-lookalike-must-not-cross",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_RANDOM_TOKEN: "prefix-lookalike-must-not-cross",
    GEMINI_API_KEY: "unrelated-provider-secret",
    GOOGLE_PRIVATE_KEY: "unrelated-provider-secret",
    OPENCODE_SESSION_TOKEN: "unrelated-provider-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/creds.json"
  };

  const claudeEnv = createClaudeBackend(env).buildAnswerCommand(answerOptions({ runtimeDir: "/tmp/run" })).env;
  assert.equal(claudeEnv.DISCORD_TOKEN, undefined);
  assert.equal(claudeEnv.APPLICATION_SECRET, undefined);
  assert.equal(claudeEnv.DEVBOT_OWNER_USER_ID, undefined);
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, "sk-ant-should-reach-claude");
  assert.equal(claudeEnv.ANTHROPIC_AUTH_TOKEN, "oat-should-reach-claude");
  assert.equal(claudeEnv.ANTHROPIC_INTERNAL_SECRET, undefined);
  assert.equal(claudeEnv.ANTHROPIC_ADMIN_KEY, undefined);
  assert.equal(claudeEnv.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(claudeEnv.CLAUDE_CODE_RANDOM_TOKEN, undefined);
  assert.equal(claudeEnv.GEMINI_API_KEY, undefined);
  assert.equal(claudeEnv.GOOGLE_PRIVATE_KEY, undefined);
  assert.equal(claudeEnv.OPENCODE_SESSION_TOKEN, undefined);
  assert.equal(claudeEnv.GOOGLE_APPLICATION_CREDENTIALS, "/creds.json");
  assert.equal(claudeEnv.PATH, "/usr/bin");
});

test("codex backend uses an isolated environment without Devbot secrets", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    DISCORD_TOKEN: "bot-token-should-never-leak",
    CODEX_HOME: "/home/dev/.codex"
  };
  const spec = createCodexBackend(codex, env).buildAnswerCommand(answerOptions({ outputFile: "/tmp/out/answer.txt" }));
  assert.equal(spec.env.DISCORD_TOKEN, undefined);
  assert.equal(spec.env.CODEX_HOME, "/home/dev/.codex");
  assert.equal(spec.env.HOME, "/tmp/out");
});

test("selection prefers explicit env, then setup; only codex is ever auto-selected", () => {
  assert.equal(selectBackendId({ envBackend: "claude", setupBackend: "gemini", detected: new Set(["codex"]) }), "claude");
  assert.equal(selectBackendId({ envBackend: "invalid", setupBackend: "gemini", detected: new Set(["codex"]) }), "gemini");
  assert.equal(selectBackendId({ setupBackend: undefined, detected: new Set(["claude", "opencode"]) }), "codex");
  assert.equal(selectBackendId({ detected: new Set(["opencode"]) }), "codex");
  assert.equal(selectBackendId({ detected: new Set(["codex", "claude", "gemini", "opencode"]) }), "codex");
  assert.equal(selectBackendId({ detected: new Set() }), "codex");
});

test("backend id normalization only accepts known ids", () => {
  assert.equal(normalizeBackendId("  CLAUDE "), "claude");
  assert.equal(normalizeBackendId("gpt"), undefined);
  assert.equal(normalizeBackendId(undefined), undefined);
  assert.deepEqual([...BACKEND_ORDER], ["codex", "claude", "gemini", "opencode"]);
});

test("claude detection requires every safety flag before reporting compatible", async () => {
  clearDetectionCache();
  const fullHelp =
    "--print --safe-mode --no-session-persistence --strict-mcp-config --permission-mode --tools --disallowedTools";
  const goodProbe = async (_bin: string, args: readonly string[]) =>
    args[0] === "--version"
      ? { installed: true, stdout: "2.1.197 (Claude Code)" }
      : { installed: true, stdout: fullHelp };
  const good = await createClaudeBackend({}, goodProbe).detect();
  assert.equal(good.installed, true);
  assert.equal(good.compatible, true);
  assert.equal(good.version, "2.1.197");

  clearDetectionCache();
  const staleProbe = async (_bin: string, args: readonly string[]) =>
    args[0] === "--version"
      ? { installed: true, stdout: "1.0.0 (Claude Code)" }
      : { installed: true, stdout: "--print --permission-mode --disallowedTools" };
  const stale = await createClaudeBackend({}, staleProbe).detect();
  assert.equal(stale.installed, true);
  assert.equal(stale.compatible, false);
  assert.match(stale.compatibilityError ?? "", /--safe-mode/);
  clearDetectionCache();
});

test("codex detection reports authentication readiness instead of treating a signed-out CLI as ready", async () => {
  clearDetectionCache();
  const calls: string[] = [];
  const signedOut = await createCodexBackend(codex, {}, async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { installed: true, stdout: "codex-cli 1.2.3", ok: true };
    return { installed: true, stdout: "Not logged in", ok: false };
  }).detect();
  assert.equal(signedOut.installed, true);
  assert.equal(signedOut.compatible, true);
  assert.equal(signedOut.authenticated, false);
  assert.match(signedOut.authenticationError ?? "", /codex login/i);
  assert.deepEqual(calls, ["--version", "login status"]);

  clearDetectionCache();
  const ready = await createCodexBackend(codex, {}, async (_bin, args) => ({
    installed: true,
    stdout: args[0] === "--version" ? "codex-cli 1.2.3" : "Logged in",
    ok: true
  })).detect();
  assert.equal(ready.authenticated, true);
  clearDetectionCache();
});

test("unverified adapters detect as installed but never as compatible for execution", async () => {
  clearDetectionCache();
  const probe = async () => ({ installed: true, stdout: "0.5.0" });
  const gemini = await createGeminiBackend({}, probe).detect();
  assert.equal(gemini.installed, true);
  assert.equal(gemini.compatible, false);
  assert.match(gemini.compatibilityError ?? "", /will not execute/i);
  const opencode = await createOpencodeBackend({}, probe).detect();
  assert.equal(opencode.compatible, false);
  clearDetectionCache();
});

test("missing binaries detect as neither installed nor compatible", async () => {
  clearDetectionCache();
  const probe = async () => ({ installed: false, stdout: "", error: "spawn claude ENOENT" });
  const availability = await createClaudeBackend({}, probe).detect();
  assert.equal(availability.installed, false);
  assert.equal(availability.compatible, false);
  clearDetectionCache();
});

test("version parsing extracts semver or falls back to the first line", () => {
  assert.equal(parseVersionOutput("codex-cli 0.144.0\n"), "0.144.0");
  assert.equal(parseVersionOutput("2.1.197 (Claude Code)"), "2.1.197");
  assert.equal(parseVersionOutput("\n\n  nightly-build  \n"), "nightly-build");
  assert.equal(parseVersionOutput("   "), undefined);
});

test("active backend id defaults to codex and normalizes assignments", () => {
  setActiveBackendId("gemini");
  assert.equal(getActiveBackendId(), "gemini");
  setActiveBackendId("nonsense");
  assert.equal(getActiveBackendId(), "codex");
  setActiveBackendId(undefined);
  assert.equal(getActiveBackendId(), "codex");
});
