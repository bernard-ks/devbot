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

test("claude backend maps answer to plan mode and action to acceptEdits with add-dir", () => {
  const backend = createClaudeBackend({});
  const answer = backend.buildAnswerCommand(answerOptions());
  assert.equal(backend.experimental, false);
  assert.equal(answer.bin, "claude");
  assert.equal(answer.outputFile, undefined);
  assert.deepEqual(answer.args, ["-p", "--permission-mode", "plan", "explain this"]);

  const action = backend.buildActionCommand(answerOptions());
  assert.deepEqual(action.args, ["-p", "--permission-mode", "acceptEdits", "--add-dir", "/tmp/project", "explain this"]);
});

test("claude backend maps configured tier models to the model flag and ignores codex model strings", () => {
  const backend = createClaudeBackend({ DEVBOT_CLAUDE_DEEP_MODEL: "opus", DEVBOT_CLAUDE_MODEL: "sonnet" });
  const deep = backend.buildAnswerCommand(answerOptions({ tier: "deep", model: "gpt-5.6-sol" }));
  assert.deepEqual(deep.args, ["-p", "--permission-mode", "plan", "--model", "opus", "explain this"]);
  const fast = backend.buildAnswerCommand(answerOptions({ tier: "fast" }));
  assert.deepEqual(fast.args, ["-p", "--permission-mode", "plan", "--model", "sonnet", "explain this"]);
  const untyped = backend.buildAnswerCommand(answerOptions());
  assert.deepEqual(untyped.args, ["-p", "--permission-mode", "plan", "explain this"]);
});

test("gemini backend is experimental and uses yolo only for action mode", () => {
  const backend = createGeminiBackend({});
  assert.equal(backend.experimental, true);
  assert.deepEqual(backend.buildAnswerCommand(answerOptions()).args, ["-p", "explain this"]);
  assert.deepEqual(backend.buildActionCommand(answerOptions()).args, ["--yolo", "-p", "explain this"]);
  const withModel = createGeminiBackend({ DEVBOT_GEMINI_STANDARD_MODEL: "gemini-2.5-pro" });
  assert.deepEqual(withModel.buildActionCommand(answerOptions({ tier: "standard" })).args, [
    "--yolo",
    "--model",
    "gemini-2.5-pro",
    "-p",
    "explain this"
  ]);
});

test("opencode backend is experimental and runs the prompt positionally", () => {
  const backend = createOpencodeBackend({});
  assert.equal(backend.experimental, true);
  assert.deepEqual(backend.buildAnswerCommand(answerOptions()).args, ["run", "explain this"]);
  const withModel = createOpencodeBackend({ DEVBOT_OPENCODE_MODEL: "anthropic/claude" });
  assert.deepEqual(withModel.buildActionCommand(answerOptions({ tier: "fast" })).args, ["run", "--model", "anthropic/claude", "explain this"]);
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
