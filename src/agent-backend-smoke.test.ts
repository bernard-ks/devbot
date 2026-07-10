import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { clearDetectionCache, setActiveBackendId } from "./agent-backend.js";
import { completeCodexPrompt } from "./codex-client.js";
import type { CodexConfig } from "./types.js";

const isWindows = process.platform === "win32";

const CODEX_SHIM = `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
prompt=$(cat)
case "$prompt" in
  *SMOKE_SLEEP*) sleep 30; exit 0 ;;
esac
case "$prompt" in
  *SMOKE_FAIL*) echo "synthetic backend failure" >&2; exit 7 ;;
esac
printf 'codex-echo:%s' "$prompt" > "$out"
exit 0
`;

const CLAUDE_SHIM = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--print --safe-mode --no-session-persistence --strict-mcp-config --permission-mode --tools --disallowedTools"
  exit 0
fi
if [ -n "$DISCORD_TOKEN" ]; then echo "devbot secret leaked" >&2; exit 8; fi
if [ "$HOME" = "__REAL_HOME__" ]; then echo "ambient home leaked" >&2; exit 10; fi
case "$*" in
  *--safe-mode*) ;;
  *) echo "missing --safe-mode" >&2; exit 9 ;;
esac
case "$*" in
  *plan*) ;;
  *) echo "missing plan permission mode" >&2; exit 9 ;;
esac
prompt=$(cat)
printf 'claude-echo:%s' "$prompt"
exit 0
`;

const MARKER_SHIM = `#!/bin/sh
touch "$(dirname "$0")/unverified-executed.marker"
exit 0
`;

let shimDir = "";
let shimCodex: CodexConfig;
const savedEnv = {
  claudeBin: process.env.DEVBOT_CLAUDE_BIN,
  geminiBin: process.env.DEVBOT_GEMINI_BIN,
  discordToken: process.env.DISCORD_TOKEN
};

async function writeShim(name: string, content: string): Promise<string> {
  const file = path.join(shimDir, name);
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
  return file;
}

function restoreEnvKey(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

before(async () => {
  if (isWindows) return;
  shimDir = await mkdtemp(path.join(tmpdir(), "devbot-shim-"));
  const codexBin = await writeShim("fake-codex", CODEX_SHIM);
  await writeShim("fake-claude", CLAUDE_SHIM.replace("__REAL_HOME__", process.env.HOME ?? homedir()));
  await writeShim("fake-unverified", MARKER_SHIM);
  shimCodex = { bin: codexBin, model: undefined, sandbox: "read-only", actionSandbox: "workspace-write", timeoutMs: 20_000 };
  process.env.DEVBOT_CLAUDE_BIN = path.join(shimDir, "fake-claude");
  process.env.DEVBOT_GEMINI_BIN = path.join(shimDir, "fake-unverified");
  process.env.DISCORD_TOKEN = "smoke-discord-secret-token";
  clearDetectionCache();
});

after(async () => {
  setActiveBackendId("codex");
  clearDetectionCache();
  restoreEnvKey("DEVBOT_CLAUDE_BIN", savedEnv.claudeBin);
  restoreEnvKey("DEVBOT_GEMINI_BIN", savedEnv.geminiBin);
  restoreEnvKey("DISCORD_TOKEN", savedEnv.discordToken);
  if (shimDir) {
    await rm(shimDir, { force: true, recursive: true });
  }
});

test("smoke: codex-style run delivers the prompt over stdin and reads the output file", { skip: isWindows }, async () => {
  setActiveBackendId("codex");
  const answer = await completeCodexPrompt({ codex: shimCodex, prompt: "hello codex smoke", cwd: shimDir });
  assert.equal(answer, "codex-echo:hello codex smoke");
});

test("smoke: claude answer run passes the flag probe, gets a scoped env and isolated HOME, and parses stdout", { skip: isWindows }, async () => {
  setActiveBackendId("claude");
  try {
    const answer = await completeCodexPrompt({ codex: shimCodex, prompt: "hello claude smoke", cwd: shimDir });
    assert.equal(answer, "claude-echo:hello claude smoke");
  } finally {
    setActiveBackendId("codex");
  }
});

test("smoke: claude action mode fails closed", { skip: isWindows }, async () => {
  setActiveBackendId("claude");
  try {
    await assert.rejects(
      completeCodexPrompt({ codex: shimCodex, prompt: "write something", cwd: shimDir, mode: "action" }),
      /task workspace/i
    );
  } finally {
    setActiveBackendId("codex");
  }
});

test("smoke: unverified backend refuses both modes and its CLI is never executed", { skip: isWindows }, async () => {
  setActiveBackendId("gemini");
  try {
    await assert.rejects(
      completeCodexPrompt({ codex: shimCodex, prompt: "write outside the worktree", cwd: shimDir, mode: "action" }),
      /task workspace/i
    );
    await assert.rejects(
      completeCodexPrompt({ codex: shimCodex, prompt: "answer something", cwd: shimDir }),
      /read-only/i
    );
    await assert.rejects(stat(path.join(shimDir, "unverified-executed.marker")), /ENOENT/);
  } finally {
    setActiveBackendId("codex");
  }
});

test("smoke: nonzero exits surface as errors with the exit code", { skip: isWindows }, async () => {
  setActiveBackendId("codex");
  await assert.rejects(
    completeCodexPrompt({ codex: shimCodex, prompt: "please SMOKE_FAIL now", cwd: shimDir }),
    /exited with code 7/
  );
});

test("smoke: timeouts terminate the child and reject", { skip: isWindows }, async () => {
  setActiveBackendId("codex");
  await assert.rejects(
    completeCodexPrompt({ codex: shimCodex, prompt: "please SMOKE_SLEEP now", cwd: shimDir, timeoutMs: 700 }),
    /timed out/
  );
});

test("smoke: cancellation aborts a running child", { skip: isWindows }, async () => {
  setActiveBackendId("codex");
  const controller = new AbortController();
  const run = completeCodexPrompt({
    codex: shimCodex,
    prompt: "please SMOKE_SLEEP now",
    cwd: shimDir,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 250);
  await assert.rejects(run, /canceled/);
});

test("smoke: repeated temp-dir creation failures release the run slot and do not reduce capacity", { skip: isWindows }, async () => {
  setActiveBackendId("codex");
  const savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const missingTmp = path.join(shimDir, "does-not-exist", "nested");
  // Force mkdtemp(join(tmpdir(), ...)) to fail with ENOENT by pointing the temp
  // root at a directory that does not exist.
  process.env.TMPDIR = missingTmp;
  process.env.TMP = missingTmp;
  process.env.TEMP = missingTmp;
  try {
    // More consecutive failures than the concurrency limit (4). If a failed run
    // leaked its slot, the fifth acquisition would block on the queue forever
    // instead of rejecting, so this loop would hang.
    for (let i = 0; i < 6; i += 1) {
      await assert.rejects(
        completeCodexPrompt({ codex: shimCodex, prompt: `temp failure ${i}`, cwd: shimDir }),
        /ENOENT|no such file|scandir|mkdtemp/i
      );
    }
  } finally {
    restoreEnvKey("TMPDIR", savedTmp.TMPDIR);
    restoreEnvKey("TMP", savedTmp.TMP);
    restoreEnvKey("TEMP", savedTmp.TEMP);
  }

  // Capacity is intact: the next valid request runs.
  const answer = await completeCodexPrompt({ codex: shimCodex, prompt: "after temp failures", cwd: shimDir });
  assert.equal(answer, "codex-echo:after temp failures");

  // And all four concurrent slots plus queued overflow are still usable.
  const answers = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      completeCodexPrompt({ codex: shimCodex, prompt: `parallel ${i}`, cwd: shimDir })
    )
  );
  assert.deepEqual(
    answers,
    Array.from({ length: 5 }, (_, i) => `codex-echo:parallel ${i}`)
  );
});
