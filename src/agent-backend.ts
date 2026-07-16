import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { minimalChildEnvironment, scopedChildEnvironment } from "./security.js";
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
  runtimeDir?: string;
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

/**
 * The security contract every backend must declare. These fields are the spec
 * the reviewer requires: they are asserted in tests and drive fail-closed
 * behavior (a backend that cannot enforce read-only refuses answer mode).
 */
export interface BackendCapabilities {
  /** Child process receives a minimal, curated environment, never process.env. */
  minimalEnvironment: boolean;
  /** Ambient user rules/plugins/extensions/MCP servers are not loaded. */
  isolatesUserConfig: boolean;
  /** The backend's task run cannot reach the network. */
  constrainsNetwork: boolean;
  /** Answer mode is guaranteed read-only by the CLI (not by prompt wording). */
  enforcesAnswerReadOnly: boolean;
  /** Action-mode writes are confined to the supplied task worktree. */
  confinesActionWorkspace: boolean;
  /** The run can be canceled/timed out via process termination. */
  supportsCancellation: boolean;
  /** The prompt is delivered off-argv so it never appears in process listings. */
  promptTransport: "stdin" | "input-file";
  /** Where the final answer is read from. */
  outputTransport: "output-file" | "stdout";
  /**
   * The command builder actually transports supplied image paths to the CLI.
   * A backend that leaves this false must never be handed images: the call
   * boundary fails closed instead of silently asking a model to inspect an
   * image it never receives.
   */
  acceptsImageInput: boolean;
}

export interface BackendAvailability {
  id: BackendId;
  displayName: string;
  binary: string;
  installed: boolean;
  experimental: boolean;
  /** The installed CLI passed this backend's required-flag/verification probe. */
  compatible: boolean;
  compatibilityError?: string;
  /** Authentication was checked and is currently usable. Undefined means this backend has no auth probe. */
  authenticated?: boolean;
  authenticationError?: string;
  capabilities: BackendCapabilities;
  version?: string;
  error?: string;
}

export interface AgentBackend {
  id: BackendId;
  displayName: string;
  binary: string;
  experimental: boolean;
  usesOutputFile: boolean;
  /** The run needs a private temporary directory to use as the child HOME. */
  usesRuntimeHome: boolean;
  capabilities: BackendCapabilities;
  detect(): Promise<BackendAvailability>;
  buildAnswerCommand(options: BuildCommandOptions): SpawnSpec;
  buildActionCommand(options: BuildCommandOptions): SpawnSpec;
}

export class ReadOnlyUnsupportedError extends Error {
  constructor(displayName: string) {
    super(
      `${displayName} cannot guarantee a read-only run, so Devbot refuses answer-mode (/ask) requests on it. ` +
        `Switch to a read-only-capable backend with /setup backend id:codex (or id:claude).`
    );
    this.name = "ReadOnlyUnsupportedError";
  }
}

export class UnconfinedActionError extends Error {
  constructor(displayName: string) {
    super(
      `${displayName} cannot confine action-mode writes to the isolated task workspace, so Devbot refuses ` +
        `action-mode (/do) requests on it. Switch to a workspace-confining backend with /setup backend id:codex.`
    );
    this.name = "UnconfinedActionError";
  }
}

export class ImageInputUnsupportedError extends Error {
  constructor(displayName: string) {
    super(
      `${displayName} cannot receive image input, so Devbot cannot transcribe or inspect attached screenshots on it. ` +
        `Switch to an image-capable backend with /setup backend id:codex.`
    );
    this.name = "ImageInputUnsupportedError";
  }
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
  /** Omitted by injected probes for backwards compatibility; only explicit false is a failed invocation. */
  ok?: boolean;
  error?: string;
}

export type CliProbe = (bin: string, args: readonly string[]) => Promise<DetectResult>;

function probeCli(bin: string, args: readonly string[], timeoutMs = 5_000): Promise<DetectResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, [...args], { env: minimalChildEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ installed: false, stdout: "", error: (error as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({ installed: true, stdout, ok: false, error: "CLI probe timed out" });
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
      finish({ installed: error.code !== "ENOENT", stdout, ok: false, error: error.message });
    });
    child.on("close", (code) => {
      const output = stdout || stderr;
      finish({
        installed: true,
        stdout: output,
        ok: code === 0,
        ...(code === 0 ? {} : { error: output.trim() || `CLI exited with status ${code ?? "unknown"}` })
      });
    });
  });
}

/**
 * A backend definition carries its verification requirements alongside the
 * command builders. `requiredFlags` are probed against the installed CLI's
 * --help output before the backend is considered executable; a
 * `verificationGap` marks an adapter whose safety has not been proven against
 * the real CLI, which keeps it visible in detection but never executable.
 */
interface BackendDefinition extends Omit<AgentBackend, "detect"> {
  requiredFlags?: readonly string[];
  verificationGap?: string;
  authenticationProbe?: {
    args: readonly string[];
    failureMessage: string;
  };
}

const detectionCache = new Map<string, Promise<BackendAvailability>>();

async function resolveCompatibility(
  backend: BackendDefinition,
  probe: CliProbe
): Promise<{ compatible: boolean; compatibilityError?: string }> {
  if (backend.verificationGap) {
    return { compatible: false, compatibilityError: backend.verificationGap };
  }
  if (!backend.requiredFlags || backend.requiredFlags.length === 0) {
    return { compatible: true };
  }
  const help = await probe(backend.binary, ["--help"]);
  const missing = backend.requiredFlags.filter((flag) => !help.stdout.includes(flag));
  if (missing.length > 0) {
    return {
      compatible: false,
      compatibilityError: `${backend.displayName} does not support required flags: ${missing.join(", ")}. Upgrade the CLI.`
    };
  }
  return { compatible: true };
}

async function resolveAuthentication(
  backend: BackendDefinition,
  probe: CliProbe
): Promise<{ authenticated?: boolean; authenticationError?: string }> {
  if (!backend.authenticationProbe) return {};
  const result = await probe(backend.binary, backend.authenticationProbe.args);
  if (result.installed && result.ok !== false && !result.error) return { authenticated: true };
  return {
    authenticated: false,
    authenticationError: backend.authenticationProbe.failureMessage
  };
}

function detectBackend(backend: BackendDefinition, probe: CliProbe): Promise<BackendAvailability> {
  const cacheKey = `${backend.id}:${backend.binary}`;
  const cached = detectionCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const run = probe(backend.binary, ["--version"]).then(async (result): Promise<BackendAvailability> => {
    const version = result.installed ? parseVersionOutput(result.stdout) : undefined;
    const compatibility = result.installed
      ? await resolveCompatibility(backend, probe)
      : { compatible: false as const };
    const authentication = result.installed && compatibility.compatible
      ? await resolveAuthentication(backend, probe)
      : {};
    return {
      id: backend.id,
      displayName: backend.displayName,
      binary: backend.binary,
      installed: result.installed,
      experimental: backend.experimental,
      compatible: compatibility.compatible,
      ...(compatibility.compatibilityError ? { compatibilityError: compatibility.compatibilityError } : {}),
      ...authentication,
      capabilities: backend.capabilities,
      ...(version ? { version } : {}),
      ...(result.error && !result.installed ? { error: result.error } : {})
    };
  });
  detectionCache.set(cacheKey, run);
  return run;
}

/**
 * The declared capabilities drive fail-closed behavior structurally: any
 * backend that does not guarantee read-only answers or workspace-confined
 * actions throws before a spawn spec exists, regardless of what its own
 * builders would produce.
 */
function finalizeBackend(backend: BackendDefinition, probe: CliProbe): AgentBackend {
  return {
    ...backend,
    buildAnswerCommand: (options) => {
      if (!backend.capabilities.enforcesAnswerReadOnly) {
        throw new ReadOnlyUnsupportedError(backend.displayName);
      }
      return backend.buildAnswerCommand(options);
    },
    buildActionCommand: (options) => {
      if (!backend.capabilities.confinesActionWorkspace) {
        throw new UnconfinedActionError(backend.displayName);
      }
      return backend.buildActionCommand(options);
    },
    detect: () => detectBackend(backend, probe)
  };
}

export function clearDetectionCache(): void {
  detectionCache.clear();
}

const CODEX_CAPABILITIES: BackendCapabilities = {
  minimalEnvironment: true,
  isolatesUserConfig: true,
  constrainsNetwork: true,
  enforcesAnswerReadOnly: true,
  confinesActionWorkspace: true,
  supportsCancellation: true,
  promptTransport: "stdin",
  outputTransport: "output-file",
  // buildCodexArgs threads imagePaths into the exec argv as `-i <path>` pairs.
  acceptsImageInput: true
};

function buildCodexArgs(
  options: BuildCommandOptions,
  codex: CodexConfig,
  defaultSandbox: CodexConfig["sandbox"],
  environment: NodeJS.ProcessEnv
): SpawnSpec {
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
    env: isolatedCodexEnvironment(environment, path.dirname(outputFile)),
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

export function createCodexBackend(codex: CodexConfig, env: NodeJS.ProcessEnv = process.env, probe: CliProbe = probeCli): AgentBackend {
  return finalizeBackend(
    {
      id: "codex",
      displayName: "Codex CLI",
      binary: codex.bin,
      experimental: false,
      usesOutputFile: true,
      usesRuntimeHome: false,
      authenticationProbe: {
        args: ["login", "status"],
        failureMessage: "Codex CLI is installed but signed out. Run `codex login`, then retry."
      },
      capabilities: CODEX_CAPABILITIES,
      buildAnswerCommand: (options) => buildCodexArgs(options, codex, codex.sandbox, env),
      buildActionCommand: (options) => buildCodexArgs(options, codex, codex.actionSandbox, env)
    },
    probe
  );
}

/**
 * Exact documented variables the Claude CLI needs for authentication and
 * first-party provider routing. Every entry is named individually; prefix
 * admission is not supported, so unrelated ANTHROPIC_- or CLAUDE_CODE_-prefixed
 * values in the bot environment never reach the child.
 */
const CLAUDE_ENV_EXACT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_REGION",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS"
] as const;

const CLAUDE_READ_ONLY_ALLOWED_TOOLS = "Read,Glob,Grep";
const CLAUDE_READ_ONLY_DENY_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"];

/**
 * Flags the answer command depends on. Detection probes --help and refuses to
 * treat the CLI as compatible unless every one is supported, so an older
 * `claude` binary that would silently ignore the safety flags never runs.
 */
const CLAUDE_REQUIRED_FLAGS = [
  "--print",
  "--safe-mode",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--permission-mode",
  "--tools",
  "--disallowedTools"
] as const;

/**
 * The child gets a private empty HOME so ambient dotfiles are unreachable,
 * while CLAUDE_CONFIG_DIR still points at the real config directory so stored
 * credentials keep working (the same split Codex gets via CODEX_HOME).
 * --safe-mode is what disables user customization; this only removes the
 * ambient home directory from the child's view.
 */
function isolatedClaudeEnvironment(environment: NodeJS.ProcessEnv, runtimeHome: string): NodeJS.ProcessEnv {
  const isolated = scopedChildEnvironment(environment, CLAUDE_ENV_EXACT_KEYS);
  const realHome = environment.HOME?.trim() || environment.USERPROFILE?.trim() || homedir();
  isolated.CLAUDE_CONFIG_DIR = environment.CLAUDE_CONFIG_DIR?.trim() || path.join(realHome, ".claude");
  isolated.HOME = runtimeHome;
  isolated.USERPROFILE = runtimeHome;
  return isolated;
}

export function createClaudeBackend(env: NodeJS.ProcessEnv = process.env, probe: CliProbe = probeCli): AgentBackend {
  const binary = envValue(env, "DEVBOT_CLAUDE_BIN") ?? "claude";
  const models = tierModels(env, "DEVBOT_CLAUDE");
  const displayName = "Claude Code";
  return finalizeBackend(
    {
      id: "claude",
      displayName,
      binary,
      experimental: false,
      usesOutputFile: false,
      usesRuntimeHome: true,
      requiredFlags: CLAUDE_REQUIRED_FLAGS,
      capabilities: {
        minimalEnvironment: true,
        // --safe-mode disables CLAUDE.md, hooks, plugins, skills, MCP servers,
        // custom commands/agents, and other customization by the CLI's own
        // contract; the child additionally runs with an isolated HOME.
        isolatesUserConfig: true,
        constrainsNetwork: false,
        // plan permission mode + a read-only tool allow list + a write/network
        // tool deny list, with MCP restricted to --mcp-config (none supplied).
        enforcesAnswerReadOnly: true,
        // The Claude CLI has no supported flag that restricts filesystem writes
        // to a single directory (--add-dir only grants extra access), so action
        // mode fails closed instead of claiming confinement.
        confinesActionWorkspace: false,
        supportsCancellation: true,
        promptTransport: "stdin",
        outputTransport: "stdout",
        // The Claude answer builder consumes no image paths, so images must
        // never be routed here; the call boundary fails closed instead.
        acceptsImageInput: false
      },
      buildAnswerCommand: (options) => {
        if (!options.runtimeDir) {
          throw new Error("Claude backend requires an isolated runtime home directory.");
        }
        const model = modelForTier(models, options.tier);
        const args = [
          "--print",
          "--safe-mode",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--permission-mode",
          "plan",
          "--tools",
          CLAUDE_READ_ONLY_ALLOWED_TOOLS,
          "--disallowedTools",
          ...CLAUDE_READ_ONLY_DENY_TOOLS,
          ...(model ? ["--model", model] : [])
        ];
        return {
          bin: binary,
          args,
          cwd: options.cwd,
          env: isolatedClaudeEnvironment(env, options.runtimeDir),
          timeoutMs: options.timeoutMs,
          stdin: options.prompt
        };
      },
      buildActionCommand: () => {
        throw new UnconfinedActionError(displayName);
      }
    },
    probe
  );
}

const UNVERIFIED_CAPABILITIES: BackendCapabilities = {
  minimalEnvironment: true,
  isolatesUserConfig: false,
  constrainsNetwork: false,
  enforcesAnswerReadOnly: false,
  confinesActionWorkspace: false,
  supportsCancellation: true,
  promptTransport: "stdin",
  outputTransport: "stdout",
  acceptsImageInput: false
};

/**
 * Gemini CLI and opencode are detection-only placeholders: neither can prove
 * read-only answers or workspace-confined actions against the real CLI yet, so
 * no spawn spec exists for either mode and no environment is ever forwarded.
 */
function createUnverifiedBackend(id: BackendId, displayName: string, binary: string, probe: CliProbe): AgentBackend {
  return finalizeBackend(
    {
      id,
      displayName,
      binary,
      experimental: true,
      usesOutputFile: false,
      usesRuntimeHome: false,
      verificationGap:
        `${displayName} has not passed a real-CLI verification of read-only answers and workspace-confined actions, ` +
        `so Devbot will not execute it.`,
      capabilities: UNVERIFIED_CAPABILITIES,
      buildAnswerCommand: () => {
        throw new ReadOnlyUnsupportedError(displayName);
      },
      buildActionCommand: () => {
        throw new UnconfinedActionError(displayName);
      }
    },
    probe
  );
}

export function createGeminiBackend(env: NodeJS.ProcessEnv = process.env, probe: CliProbe = probeCli): AgentBackend {
  return createUnverifiedBackend("gemini", "Gemini CLI", envValue(env, "DEVBOT_GEMINI_BIN") ?? "gemini", probe);
}

export function createOpencodeBackend(env: NodeJS.ProcessEnv = process.env, probe: CliProbe = probeCli): AgentBackend {
  return createUnverifiedBackend("opencode", "opencode", envValue(env, "DEVBOT_OPENCODE_BIN") ?? "opencode", probe);
}

export function createBackends(codex: CodexConfig, env: NodeJS.ProcessEnv = process.env, probe: CliProbe = probeCli): AgentBackend[] {
  return [
    createCodexBackend(codex, env, probe),
    createClaudeBackend(env, probe),
    createGeminiBackend(env, probe),
    createOpencodeBackend(env, probe)
  ];
}

export function normalizeBackendId(value: string | undefined): BackendId | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && (BACKEND_ORDER as readonly string[]).includes(trimmed) ? (trimmed as BackendId) : undefined;
}

/**
 * Only Codex may be chosen automatically. Every other backend requires an
 * explicit owner opt-in through DEVBOT_AGENT_BACKEND or /setup backend, so an
 * incidentally installed CLI can never become the executor by mere presence.
 */
const AUTO_SELECTABLE_BACKENDS: readonly BackendId[] = ["codex"];

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
  for (const id of AUTO_SELECTABLE_BACKENDS) {
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
