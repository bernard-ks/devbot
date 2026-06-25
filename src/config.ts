import "dotenv/config";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig, ProjectCommands, ProjectEntry, ProjectMap, ProjectMetadata } from "./types.js";

const DEFAULT_SCANNER = {
  maxIndexedFileBytes: 80_000,
  maxSnippetCharsPerFile: 12_000,
  maxPackedContextChars: 120_000,
  maxRankedFiles: 36
};

export function loadConfig(): AppConfig {
  const projects = loadProjects();

  return {
    ...loadDiscordConfig(),
    codex: loadCodexConfig(),
    allowedUserIds: csvSet(process.env.ALLOWED_USER_IDS),
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

function loadCodexConfig() {
  const sandbox = process.env.CODEX_SANDBOX?.trim() || "read-only";
  if (!isCodexSandbox(sandbox)) {
    throw new Error(`Invalid CODEX_SANDBOX: ${sandbox}`);
  }

  const actionSandbox = process.env.CODEX_ACTION_SANDBOX?.trim() || "workspace-write";
  if (!isCodexSandbox(actionSandbox)) {
    throw new Error(`Invalid CODEX_ACTION_SANDBOX: ${actionSandbox}`);
  }

  return {
    bin: process.env.CODEX_BIN?.trim() || "/Applications/Codex.app/Contents/Resources/codex",
    model: process.env.CODEX_MODEL?.trim() || undefined,
    sandbox,
    actionSandbox,
    timeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 180_000)
  };
}

export function loadDiscordConfig(): Pick<AppConfig, "discordToken" | "discordClientId" | "discordGuildId"> {
  return {
    discordToken: requiredEnv("DISCORD_TOKEN"),
    discordClientId: requiredEnv("DISCORD_CLIENT_ID"),
    discordGuildId: requiredEnv("DISCORD_GUILD_ID")
  };
}

function isCodexSandbox(value: string): value is "read-only" | "workspace-write" | "danger-full-access" {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function loadProjects(): ProjectEntry[] {
  const raw = process.env.PROJECTS_JSON?.trim() || readProjectsFile();
  if (!raw) {
    throw new Error("No projects configured. Set PROJECTS_JSON or create config/projects.json.");
  }

  let parsed: ProjectMap;
  try {
    parsed = JSON.parse(raw) as ProjectMap;
  } catch (error) {
    throw new Error(`Project configuration is not valid JSON: ${(error as Error).message}`);
  }

  const entries = Object.entries(parsed)
    .filter(([name, projectPath]) => name.trim() && projectPath.trim())
    .map(([name, projectPath]) => {
      const root = path.resolve(projectPath);
      const projectName = normalizeProjectName(name);
      return {
        name: projectName,
        root,
        metadata: loadProjectMetadata(root, projectName)
      };
    });

  if (entries.length === 0) {
    throw new Error("Project configuration did not contain any usable project entries.");
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

function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
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
    commands
  };
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
