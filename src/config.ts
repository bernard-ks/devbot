import "dotenv/config";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { normalizeDiscordUsernames } from "./access.js";
import type { AppConfig, ProjectCommands, ProjectEntry, ProjectMap, ProjectMetadata } from "./types.js";

const DEFAULT_SCANNER = {
  maxIndexedFileBytes: 80_000,
  maxSnippetCharsPerFile: 12_000,
  maxPackedContextChars: 120_000,
  maxRankedFiles: 36
};

export function loadConfig(): AppConfig {
  const projects = loadProjects();
  const codex = loadCodexConfig();

  return {
    ...loadDiscordConfig(),
    ownerUserId: process.env.DEVBOT_OWNER_USER_ID?.trim() || undefined,
    autoDeployCommands: parseBoolean(process.env.DEVBOT_AUTO_DEPLOY_COMMANDS, true),
    codex,
    routing: loadRoutingConfig(codex.model),
    allowedUserIds: csvSet(process.env.ALLOWED_USER_IDS),
    allowedUsernames: normalizedUsernameSet(process.env.ALLOWED_USERNAMES),
    allowedRoleIds: csvSet(process.env.ALLOWED_ROLE_IDS),
    safeMode: parseBoolean(process.env.DEVBOT_SAFE_MODE, false),
    botIdentity: {
      owner: process.env.BOT_OWNER?.trim() || "local",
      displayName: process.env.BOT_DISPLAY_NAME?.trim() || process.env.DISCORD_BOT_NAME?.trim() || "devbot"
    },
    peerBotIds: csvSet(process.env.PEER_BOT_IDS),
    coordinationChannelId: process.env.COORDINATION_CHANNEL_ID?.trim() || undefined,
    projects,
    scanner: DEFAULT_SCANNER
  };
}

function loadRoutingConfig(defaultModel: string | undefined) {
  const routerModel = process.env.CODEX_ROUTER_MODEL?.trim() || undefined;
  return {
    enabled: parseBoolean(process.env.CODEX_ROUTING_ENABLED, Boolean(routerModel)),
    routerModel,
    routerReasoningEffort: process.env.CODEX_ROUTER_REASONING_EFFORT?.trim() || "low",
    routerTimeoutMs: Number(process.env.CODEX_ROUTER_TIMEOUT_MS || 30_000),
    fastModel: process.env.CODEX_FAST_MODEL?.trim() || defaultModel,
    fastReasoningEffort: process.env.CODEX_FAST_REASONING_EFFORT?.trim() || undefined,
    standardModel: process.env.CODEX_STANDARD_MODEL?.trim() || defaultModel,
    standardReasoningEffort: process.env.CODEX_STANDARD_REASONING_EFFORT?.trim() || undefined,
    deepModel: process.env.CODEX_DEEP_MODEL?.trim() || defaultModel,
    deepReasoningEffort: process.env.CODEX_DEEP_REASONING_EFFORT?.trim() || undefined,
    focusedContextChars: Number(process.env.CODEX_FOCUSED_CONTEXT_CHARS || 24_000)
  };
}

export function loadCodexConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig["codex"] {
  const sandbox = environment.CODEX_SANDBOX?.trim() || "read-only";
  if (sandbox !== "read-only") {
    throw new Error("CODEX_SANDBOX must be read-only for Discord-initiated answer requests.");
  }

  const actionSandbox = environment.CODEX_ACTION_SANDBOX?.trim() || "workspace-write";
  if (actionSandbox !== "read-only" && actionSandbox !== "workspace-write") {
    throw new Error(`Invalid CODEX_ACTION_SANDBOX: ${actionSandbox}`);
  }

  return {
    bin: resolveCodexBin(environment.CODEX_BIN),
    model: environment.CODEX_MODEL?.trim() || undefined,
    sandbox,
    actionSandbox,
    timeoutMs: Number(environment.CODEX_TIMEOUT_MS || 180_000)
  };
}

const BUNDLED_CODEX_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex"
];

export function resolveCodexBin(
  configured: string | undefined,
  bundledCandidates = BUNDLED_CODEX_CANDIDATES,
  fileExists: (candidate: string) => boolean = existsSync
): string {
  const preferred = configured?.trim();
  if (preferred && (!path.isAbsolute(preferred) || fileExists(preferred))) {
    return preferred;
  }

  return bundledCandidates.find(fileExists) ?? preferred ?? "codex";
}

export function loadDiscordConfig(): Pick<AppConfig, "discordToken" | "discordClientId" | "discordGuildId"> {
  return {
    discordToken: requiredEnv("DISCORD_TOKEN"),
    discordClientId: requiredEnv("DISCORD_CLIENT_ID"),
    discordGuildId: requiredEnv("DISCORD_GUILD_ID")
  };
}

function loadProjects(): ProjectEntry[] {
  const raw = process.env.PROJECTS_JSON?.trim() || readProjectsFile();
  if (!raw) {
    return [];
  }

  let parsed: ProjectMap;
  try {
    parsed = JSON.parse(raw) as ProjectMap;
  } catch (error) {
    throw new Error(`Project configuration is not valid JSON: ${(error as Error).message}`);
  }

  const entries = Object.entries(parsed)
    .filter(([name, projectPath]) => name.trim() && projectPath.trim())
    .map(([name, projectPath]) => loadProjectEntry(name, expandEnvPlaceholders(projectPath, `project ${name}`)));

  const configuredDefault = process.env.DEFAULT_PROJECT?.trim();
  if (configuredDefault) {
    const normalizedDefault = normalizeProjectName(configuredDefault);
    const selected = entries.find((entry) => entry.name === normalizedDefault);
    if (!selected) {
      throw new Error(`DEFAULT_PROJECT does not match a configured project: ${configuredDefault}`);
    }
    selected.isDefault = true;
  } else if (entries.length === 1 && entries[0]) {
    entries[0].isDefault = true;
  }

  return entries;
}

function readProjectsFile(): string | undefined {
  const projectFile = path.resolve("config/projects.json");
  if (!existsSync(projectFile)) {
    return undefined;
  }

  return readFileSync(projectFile, "utf8");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function normalizedUsernameSet(value: string | undefined): Set<string> {
  return new Set(normalizeDiscordUsernames((value ?? "").split(",")));
}

export function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

export function loadProjectEntry(name: string, projectPath: string): ProjectEntry {
  const root = path.resolve(projectPath);
  const projectName = normalizeProjectName(name);
  return {
    name: projectName,
    root,
    metadata: loadProjectMetadata(root, projectName)
  };
}

export function expandEnvPlaceholders(value: string, label = "value"): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => {
    const replacement = process.env[name]?.trim();
    if (!replacement) {
      throw new Error(`Missing environment variable ${name} referenced by ${label}.`);
    }

    return replacement;
  });
}

function loadProjectMetadata(root: string, projectName: string): ProjectMetadata {
  const metadataFile = path.join(root, ".devbot", "project.json");
  const raw = existsSync(metadataFile) ? readJsonObject(metadataFile) : {};
  const commands = readCommands(raw.commands);
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map(String).map(normalizeProjectName).filter(Boolean) : [];

  return {
    canonicalName: stringValue(raw.canonicalName) ?? stringValue(raw.name),
    repoUrl: stringValue(raw.repoUrl),
    defaultBranch: stringValue(raw.defaultBranch) ?? "main",
    frontendUrl: stringValue(raw.frontendUrl),
    backendUrl: stringValue(raw.backendUrl),
    ownerBot: stringValue(raw.ownerBot),
    aliases,
    commands,
    policy: readProjectPolicy(raw.policy)
  };
}

function readProjectPolicy(value: unknown): ProjectMetadata["policy"] {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("Project policy must be a JSON object.");
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  const visibility = stringValue(raw.visibility);
  const screenshotPolicy = stringValue(raw.screenshotPolicy);
  if (visibility && visibility !== "private" && visibility !== "team" && visibility !== "public") {
    throw new Error(`Unsupported project policy visibility: ${visibility}.`);
  }
  if (screenshotPolicy && screenshotPolicy !== "allow" && screenshotPolicy !== "approval" && screenshotPolicy !== "deny") {
    throw new Error(`Unsupported project screenshot policy: ${screenshotPolicy}.`);
  }
  const maxContextChars = numberValue(raw.maxContextChars);
  if (raw.maxContextChars !== undefined && maxContextChars === undefined) {
    throw new Error("Project policy maxContextChars must be a positive number.");
  }
  return {
    visibility: visibility === "team" || visibility === "public" ? visibility : "private",
    allowedUsers: stringArray(raw.allowedUsers),
    allowedUsernames: normalizeDiscordUsernames(stringArray(raw.allowedUsernames)),
    allowedRoles: stringArray(raw.allowedRoles),
    allowedPeers: stringArray(raw.allowedPeers),
    screenshotPolicy: screenshotPolicy === "allow" || screenshotPolicy === "deny" ? screenshotPolicy : "approval",
    maxContextChars,
    readOnlyCommands: stringArray(raw.readOnlyCommands).map(normalizeProjectName),
    approvalRequiredCommands: stringArray(raw.approvalRequiredCommands).map(normalizeProjectName)
  };
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the root value must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Unable to load project metadata at ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

function readCommands(value: unknown): ProjectCommands {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const presets = raw.presets && typeof raw.presets === "object" && !Array.isArray(raw.presets) ? raw.presets : {};

  return {
    test: stringArray(raw.test),
    build: stringArray(raw.build),
    lint: stringArray(raw.lint),
    verify: stringArray(raw.verify),
    presets: Object.fromEntries(
      Object.entries(presets)
        .map(([name, command]) => [normalizeProjectName(name), stringValue(command)])
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
    )
  };
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }

  const single = stringValue(value);
  return single ? [single] : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
