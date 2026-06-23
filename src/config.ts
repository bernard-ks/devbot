import "dotenv/config";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig, ProjectEntry, ProjectMap } from "./types.js";

const DEFAULT_SCANNER = {
  maxIndexedFileBytes: 80_000,
  maxSnippetCharsPerFile: 12_000,
  maxPackedContextChars: 120_000,
  maxRankedFiles: 36
};

export function loadConfig(): AppConfig {
  const projects = loadProjects();

  return {
    discordToken: requiredEnv("DISCORD_TOKEN"),
    discordClientId: requiredEnv("DISCORD_CLIENT_ID"),
    discordGuildId: requiredEnv("DISCORD_GUILD_ID"),
    openaiApiKey: requiredEnv("OPENAI_API_KEY"),
    openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.5",
    allowedUserIds: csvSet(process.env.ALLOWED_USER_IDS),
    allowedRoleIds: csvSet(process.env.ALLOWED_ROLE_IDS),
    projects,
    scanner: DEFAULT_SCANNER
  };
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
    .map(([name, projectPath]) => ({
      name: normalizeProjectName(name),
      root: path.resolve(projectPath)
    }));

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
