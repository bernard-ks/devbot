import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKEND_ORDER,
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

test("claude backend hardens answer to plan mode with strict-mcp-config and blocks write tools", () => {
  const backend = createClaudeBackend({});
  const answer = backend.buildAnswerCommand(answerOptions());
  assert.equal(backend.experimental, false);
  assert.equal(answer.bin, "claude");
  assert.equal(answer.outputFile, undefined);
  assert.deepEqual(answer.args, [
    "-p",
    "--strict-mcp-config",
    "--permission-mode",
    "plan",
    "--disallowedTools",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "Bash",
    "WebFetch",
    "WebSearch"
  ]);

  const action = backend.buildActionCommand(answerOptions());
  assert.deepEqual(action.args, ["-p", "--strict-mcp-config", "--permission-mode", "acceptEdits", "--add-dir", "/tmp/project"]);
});

test("claude backend declares a read-only-capable, minimal-env, confined capability contract", () => {
  const backend = createClaudeBackend({});
  assert.deepEqual(backend.capabilities, {
    minimalEnvironment: true,
    isolatesUserConfig: true,
    constrainsNetwork: false,
    enforcesAnswerReadOnly: true,
    confinesActionWorkspace: true,
    supportsCancellation: true,
    promptTransport: "stdin",
    outputTransport: "stdout"
  });
});

test("claude backend maps configured tier models to the model flag and ignores codex model strings", () => {
  const backend = createClaudeBackend({ DEVBOT_CLAUDE_DEEP_MODEL: "opus", DEVBOT_CLAUDE_MODEL: "sonnet" });
  const deep = backend.buildAnswerCommand(answerOptions({ tier: "deep", model: "gpt-5.6-sol" }));
  assert.deepEqual(deep.args.slice(-2), ["--model", "opus"]);
  const fast = backend.buildAnswerCommand(answerOptions({ tier: "fast" }));
  assert.deepEqual(fast.args.slice(-2), ["--model", "sonnet"]);
  const untyped = backend.buildAnswerCommand(answerOptions());
  assert.equal(untyped.args.includes("--model"), false);
});

test("gemini backend is experimental, refuses read-only answers, and uses yolo for action", () => {
  const backend = createGeminiBackend({});
  assert.equal(backend.experimental, true);
  assert.equal(backend.capabilities.enforcesAnswerReadOnly, false);
  assert.throws(() => backend.buildAnswerCommand(answerOptions()), /read-only/i);
  assert.deepEqual(backend.buildActionCommand(answerOptions()).args, ["--yolo"]);
  const withModel = createGeminiBackend({ DEVBOT_GEMINI_STANDARD_MODEL: "gemini-2.5-pro" });
  assert.deepEqual(withModel.buildActionCommand(answerOptions({ tier: "standard" })).args, [
    "--yolo",
    "--model",
    "gemini-2.5-pro"
  ]);
});

test("opencode backend is experimental, refuses read-only answers, and runs prompt off-argv", () => {
  const backend = createOpencodeBackend({});
  assert.equal(backend.experimental, true);
  assert.equal(backend.capabilities.enforcesAnswerReadOnly, false);
  assert.throws(() => backend.buildAnswerCommand(answerOptions()), /read-only/i);
  assert.deepEqual(backend.buildActionCommand(answerOptions()).args, ["run"]);
  const withModel = createOpencodeBackend({ DEVBOT_OPENCODE_MODEL: "anthropic/claude" });
  assert.deepEqual(withModel.buildActionCommand(answerOptions({ tier: "fast" })).args, ["run", "--model", "anthropic/claude"]);
});

test("no backend places the prompt in argv; every backend delivers it off-argv", () => {
  const secret = "top-secret-prompt-body-42";
  const opts = answerOptions({ prompt: secret, outputFile: "/tmp/out/answer.txt" });
  const specs = [
    createCodexBackend(codex).buildAnswerCommand(opts),
    createClaudeBackend({}).buildAnswerCommand(opts),
    createClaudeBackend({}).buildActionCommand(opts),
    createGeminiBackend({}).buildActionCommand(opts),
    createOpencodeBackend({}).buildActionCommand(opts)
  ];
  for (const spec of specs) {
    assert.equal(spec.args.includes(secret), false, `prompt must not appear in argv for ${spec.bin}`);
    assert.equal(spec.args.some((arg) => arg.includes(secret)), false, `no argv token may embed the prompt for ${spec.bin}`);
    assert.equal(spec.stdin, secret, `prompt must be delivered over stdin for ${spec.bin}`);
  }
});

test("non-codex backends never forward Devbot secrets but do forward their own documented auth", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    DISCORD_TOKEN: "bot-token-should-never-leak",
    DEVBOT_OWNER_USER_ID: "123",
    APPLICATION_SECRET: "nope",
    ANTHROPIC_API_KEY: "sk-ant-should-reach-claude",
    GEMINI_API_KEY: "gem-should-reach-gemini",
    GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
    OPENAI_API_KEY: "sk-open-should-reach-opencode"
  };

  const claudeEnv = createClaudeBackend(env).buildActionCommand(answerOptions()).env;
  assert.equal(claudeEnv.DISCORD_TOKEN, undefined);
  assert.equal(claudeEnv.APPLICATION_SECRET, undefined);
  assert.equal(claudeEnv.DEVBOT_OWNER_USER_ID, undefined);
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, "sk-ant-should-reach-claude");
  assert.equal(claudeEnv.PATH, "/usr/bin");

  const geminiEnv = createGeminiBackend(env).buildActionCommand(answerOptions()).env;
  assert.equal(geminiEnv.DISCORD_TOKEN, undefined);
  assert.equal(geminiEnv.GEMINI_API_KEY, "gem-should-reach-gemini");
  assert.equal(geminiEnv.GOOGLE_APPLICATION_CREDENTIALS, "/creds.json");
  assert.equal(geminiEnv.ANTHROPIC_API_KEY, undefined);

  const opencodeEnv = createOpencodeBackend(env).buildActionCommand(answerOptions()).env;
  assert.equal(opencodeEnv.DISCORD_TOKEN, undefined);
  assert.equal(opencodeEnv.OPENAI_API_KEY, "sk-open-should-reach-opencode");
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

test("selection precedence prefers env, then setup, then detection order, then codex", () => {
  assert.equal(selectBackendId({ envBackend: "claude", setupBackend: "gemini", detected: new Set(["codex"]) }), "claude");
  assert.equal(selectBackendId({ envBackend: "invalid", setupBackend: "gemini", detected: new Set(["codex"]) }), "gemini");
  assert.equal(selectBackendId({ setupBackend: undefined, detected: new Set(["claude", "opencode"]) }), "claude");
  assert.equal(selectBackendId({ detected: new Set(["opencode"]) }), "opencode");
  assert.equal(selectBackendId({ detected: new Set() }), "codex");
});

test("backend id normalization only accepts known ids", () => {
  assert.equal(normalizeBackendId("  CLAUDE "), "claude");
  assert.equal(normalizeBackendId("gpt"), undefined);
  assert.equal(normalizeBackendId(undefined), undefined);
  assert.deepEqual([...BACKEND_ORDER], ["codex", "claude", "gemini", "opencode"]);
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
