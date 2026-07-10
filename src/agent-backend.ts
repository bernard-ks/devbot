import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { minimalChildEnvironment } from "./security.js";
import type { CodexConfig } from "./types.js";

export type AgentRequestMode = "answer" | "action";
export type AgentModelTier = "fast" | "standard" | "deep";

export const BACKEND_ORDER = ["codex", "claude", "gemini", "opencode"] as const;
export type BackendId = (typeof BACKEND_ORDER)[number];

export interface SpawnSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  outputFile?: string;
}

export interface BuildCommandOptions {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  tier?: AgentModelTier;
  model?: string;
  reasoningEffort?: string;
  outputFile?: string;
  skipGitRepoCheck?: boolean;
  imagePaths?: string[];
  sandbox?: CodexConfig["sandbox"];
}

export function buildImageExecArgs(imagePaths: string[]): string[] {
  const args: string[] = [];
  for (const imagePath of imagePaths) {
    if (imagePath.trim()) {
      args.push("-i", imagePath);
    }
  }
  return args;
}

export interface BackendAvailability {
  id: BackendId;
  displayName: string;
  binary: string;
  installed: boolean;
  experimental: boolean;
  version?: string;
  error?: string;
}

export interface AgentBackend {
  id: BackendId;
  displayName: string;
  binary: string;
  experimental: boolean;
  usesOutputFile: boolean;
  detect(): Promise<BackendAvailability>;
  buildAnswerCommand(options: BuildCommandOptions): SpawnSpec;
  buildActionCommand(options: BuildCommandOptions): SpawnSpec;
}

type TierModels = Partial<Record<AgentModelTier, string>>;

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function tierModels(env: NodeJS.ProcessEnv, prefix: string): TierModels {
  const base = envValue(env, `${prefix}_MODEL`);
  const models: TierModels = {};
  const fast = envValue(env, `${prefix}_FAST_MODEL`) ?? base;
  const standard = envValue(env, `${prefix}_STANDARD_MODEL`) ?? base;
  const deep = envValue(env, `${prefix}_DEEP_MODEL`) ?? base;
  if (fast) models.fast = fast;
  if (standard) models.standard = standard;
  if (deep) models.deep = deep;
  return models;
}

function modelForTier(models: TierModels, tier: AgentModelTier | undefined): string | undefined {
  return tier ? models[tier] : undefined;
}

export function parseVersionOutput(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? text;
  const semver = firstLine.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/);
  if (semver) {
    return semver[0];
  }
  return firstLine.trim().slice(0, 60);
}

interface DetectResult {
  installed: boolean;
  stdout: string;
  error?: string;
}

function probeVersion(bin: string, timeoutMs = 5_000): Promise<DetectResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["--version"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ installed: false, stdout: "", error: (error as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({ installed: true, stdout, error: "version probe timed out" });
    }, timeoutMs);
    const finish = (result: DetectResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ installed: error.code !== "ENOENT", stdout, error: error.message });
    });
    child.on("close", () => {
      finish({ installed: true, stdout: stdout || stderr });
    });
  });
}

const detectionCache = new Map<string, Promise<BackendAvailability>>();

function detectBackend(backend: Omit<AgentBackend, "detect">, probe = probeVersion): Promise<BackendAvailability> {
  const cacheKey = `${backend.id}:${backend.binary}`;
  const cached = detectionCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const run = probe(backend.binary).then((result): BackendAvailability => {
    const version = result.installed ? parseVersionOutput(result.stdout) : undefined;
    return {
      id: backend.id,
      displayName: backend.displayName,
      binary: backend.binary,
      installed: result.installed,
      experimental: backend.experimental,
      ...(version ? { version } : {}),
      ...(result.error && !result.installed ? { error: result.error } : {})
    };
  });
  detectionCache.set(cacheKey, run);
  return run;
}

export function clearDetectionCache(): void {
  detectionCache.clear();
}

function buildCodexArgs(options: BuildCommandOptions, codex: CodexConfig, defaultSandbox: CodexConfig["sandbox"]): SpawnSpec {
  const outputFile = options.outputFile;
  if (!outputFile) {
    throw new Error("Codex backend requires an output file for the final message.");
  }
  const sandbox = options.sandbox ?? defaultSandbox;
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--strict-config",
    "--sandbox",
    sandbox,
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
    "web_search=\"disabled\"",
    "--config",
    "sandbox_workspace_write.network_access=false",
    "--config",
    "shell_environment_policy.inherit=\"core\"",
    "--config",
    "shell_environment_policy.include_only=[\"PATH\",\"HOME\",\"USER\",\"LOGNAME\",\"SHELL\",\"TMPDIR\",\"TEMP\",\"TMP\",\"LANG\",\"LC_*\",\"TERM\",\"COLORTERM\",\"NO_COLOR\",\"FORCE_COLOR\",\"CI\"]",
    "--cd",
    options.cwd,
    "--output-last-message",
    outputFile,
    "-"
  ];
  if (options.skipGitRepoCheck) {
    args.splice(args.length - 1, 0, "--skip-git-repo-check");
  }
  if (options.imagePaths?.length) {
    args.splice(args.length - 1, 0, ...buildImageExecArgs(options.imagePaths));
  }
  const model = options.model ?? codex.model;
  const execOptionIndex = args.indexOf("exec") + 1;
  if (model) {
    args.splice(execOptionIndex, 0, "--model", model);
  }
  if (options.reasoningEffort) {
    args.splice(execOptionIndex, 0, "--config", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`);
  }
  return {
    bin: codex.bin,
    args,
    cwd: options.cwd,
    env: isolatedCodexEnvironment(process.env, path.dirname(outputFile)),
    timeoutMs: options.timeoutMs,
    stdin: options.prompt,
    outputFile
  };
}

function isolatedCodexEnvironment(environment: NodeJS.ProcessEnv, runtimeHome: string): NodeJS.ProcessEnv {
  const isolated = minimalChildEnvironment(environment, "codex");
  const realHome = environment.HOME?.trim() || environment.USERPROFILE?.trim() || homedir();
  isolated.CODEX_HOME = environment.CODEX_HOME?.trim() || path.join(realHome, ".codex");
  isolated.HOME = runtimeHome;
  isolated.USERPROFILE = runtimeHome;
  delete isolated.XDG_CONFIG_HOME;
  delete isolated.XDG_DATA_HOME;
  return isolated;
}

export function createCodexBackend(codex: CodexConfig, probe = probeVersion): AgentBackend {
  const backend: Omit<AgentBackend, "detect"> = {
    id: "codex",
    displayName: "Codex CLI",
    binary: codex.bin,
    experimental: false,
    usesOutputFile: true,
    buildAnswerCommand: (options) => buildCodexArgs(options, codex, codex.sandbox),
    buildActionCommand: (options) => buildCodexArgs(options, codex, codex.actionSandbox)
  };
  return { ...backend, detect: () => detectBackend(backend, probe) };
}

export function createClaudeBackend(env: NodeJS.ProcessEnv = process.env, probe = probeVersion): AgentBackend {
  const binary = envValue(env, "DEVBOT_CLAUDE_BIN") ?? "claude";
  const models = tierModels(env, "DEVBOT_CLAUDE");
  const base = (options: BuildCommandOptions, extra: string[]): SpawnSpec => {
    const model = modelForTier(models, options.tier);
    const args = ["-p", ...extra, ...(model ? ["--model", model] : []), options.prompt];
    return { bin: binary, args, cwd: options.cwd, env: process.env, timeoutMs: options.timeoutMs };
  };
  const backend: Omit<AgentBackend, "detect"> = {
    id: "claude",
    displayName: "Claude Code",
    binary,
    experimental: false,
    usesOutputFile: false,
    buildAnswerCommand: (options) => base(options, ["--permission-mode", "plan"]),
    buildActionCommand: (options) => base(options, ["--permission-mode", "acceptEdits", "--add-dir", options.cwd])
  };
  return { ...backend, detect: () => detectBackend(backend, probe) };
}

export function createGeminiBackend(env: NodeJS.ProcessEnv = process.env, probe = probeVersion): AgentBackend {
  const binary = envValue(env, "DEVBOT_GEMINI_BIN") ?? "gemini";
  const models = tierModels(env, "DEVBOT_GEMINI");
  const base = (options: BuildCommandOptions, extra: string[]): SpawnSpec => {
    const model = modelForTier(models, options.tier);
    const args = [...extra, ...(model ? ["--model", model] : []), "-p", options.prompt];
    return { bin: binary, args, cwd: options.cwd, env: process.env, timeoutMs: options.timeoutMs };
  };
  const backend: Omit<AgentBackend, "detect"> = {
    id: "gemini",
    displayName: "Gemini CLI",
    binary,
    experimental: true,
    usesOutputFile: false,
    buildAnswerCommand: (options) => base(options, []),
    buildActionCommand: (options) => base(options, ["--yolo"])
  };
  return { ...backend, detect: () => detectBackend(backend, probe) };
}

export function createOpencodeBackend(env: NodeJS.ProcessEnv = process.env, probe = probeVersion): AgentBackend {
  const binary = envValue(env, "DEVBOT_OPENCODE_BIN") ?? "opencode";
  const models = tierModels(env, "DEVBOT_OPENCODE");
  const base = (options: BuildCommandOptions): SpawnSpec => {
    const model = modelForTier(models, options.tier);
    const args = ["run", ...(model ? ["--model", model] : []), options.prompt];
    return { bin: binary, args, cwd: options.cwd, env: process.env, timeoutMs: options.timeoutMs };
  };
  const backend: Omit<AgentBackend, "detect"> = {
    id: "opencode",
    displayName: "opencode",
    binary,
    experimental: true,
    usesOutputFile: false,
    buildAnswerCommand: (options) => base(options),
    buildActionCommand: (options) => base(options)
  };
  return { ...backend, detect: () => detectBackend(backend, probe) };
}

export function createBackends(codex: CodexConfig, env: NodeJS.ProcessEnv = process.env, probe = probeVersion): AgentBackend[] {
  return [
    createCodexBackend(codex, probe),
    createClaudeBackend(env, probe),
    createGeminiBackend(env, probe),
    createOpencodeBackend(env, probe)
  ];
}

export function normalizeBackendId(value: string | undefined): BackendId | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && (BACKEND_ORDER as readonly string[]).includes(trimmed) ? (trimmed as BackendId) : undefined;
}

export function selectBackendId(input: {
  envBackend?: string | undefined;
  setupBackend?: string | undefined;
  detected: Set<BackendId>;
}): BackendId {
  const explicit = normalizeBackendId(input.envBackend);
  if (explicit) {
    return explicit;
  }
  const setup = normalizeBackendId(input.setupBackend);
  if (setup) {
    return setup;
  }
  for (const id of BACKEND_ORDER) {
    if (input.detected.has(id)) {
      return id;
    }
  }
  return "codex";
}

let activeBackendId: BackendId = "codex";

export function getActiveBackendId(): BackendId {
  return activeBackendId;
}

export function setActiveBackendId(id: string | undefined): BackendId {
  activeBackendId = normalizeBackendId(id) ?? "codex";
  return activeBackendId;
}

export function getActiveBackend(codex: CodexConfig, env: NodeJS.ProcessEnv = process.env): AgentBackend {
  const backends = createBackends(codex, env);
  return backends.find((backend) => backend.id === activeBackendId) ?? backends[0]!;
}

export async function detectBackends(codex: CodexConfig, env: NodeJS.ProcessEnv = process.env): Promise<BackendAvailability[]> {
  return Promise.all(createBackends(codex, env).map((backend) => backend.detect()));
}

export async function initActiveBackend(
  codex: CodexConfig,
  selection: { envBackend?: string | undefined; setupBackend?: string | undefined },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ activeId: BackendId; availabilities: BackendAvailability[] }> {
  const availabilities = await detectBackends(codex, env);
  const detected = new Set<BackendId>(availabilities.filter((item) => item.installed).map((item) => item.id));
  activeBackendId = selectBackendId({ envBackend: selection.envBackend, setupBackend: selection.setupBackend, detected });
  return { activeId: activeBackendId, availabilities };
}
