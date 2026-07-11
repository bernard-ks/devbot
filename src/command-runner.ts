import { exec } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { minimalChildEnvironment, sanitizeDiscordOutput } from "./security.js";
import type { ProjectEntry } from "./types.js";

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 180_000;

export type ProjectCommandKind = "test" | "build" | "lint" | "verify";

export interface ProjectCommandResult {
  projectName: string;
  kind: string;
  command: string;
  ok: boolean;
  exitCode: number | undefined;
  output: string;
  startedAt: string;
  finishedAt: string;
}

export function configuredCommandNames(project: ProjectEntry): string[] {
  const builtIns = (["test", "build", "lint", "verify"] as ProjectCommandKind[]).filter(
    (kind) => project.metadata.commands[kind].length > 0
  );
  return [...builtIns, ...Object.keys(project.metadata.commands.presets)].sort();
}

export function resolveProjectCommand(project: ProjectEntry, name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  if (isProjectCommandKind(normalized)) {
    return project.metadata.commands[normalized][0];
  }

  return project.metadata.commands.presets[normalized];
}

export async function runConfiguredProjectCommand(
  project: ProjectEntry,
  name: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProjectCommandResult> {
  const command = resolveProjectCommand(project, name);
  if (!command) {
    throw new Error(`No configured command named ${name} for ${project.name}. Add a command preset in that project's Devbot configuration.`);
  }

  const startedAt = new Date().toISOString();
  const runtimeHome = await mkdtemp(path.join(tmpdir(), "devbot-command-"));
  const childEnvironment = minimalChildEnvironment();
  childEnvironment.HOME = runtimeHome;
  childEnvironment.USERPROFILE = runtimeHome;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: project.root,
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
      env: childEnvironment
    });
    return {
      projectName: project.name,
      kind: name,
      command: sanitizeDiscordOutput(command),
      ok: true,
      exitCode: 0,
      output: trimOutput(sanitizeDiscordOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`)),
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      projectName: project.name,
      kind: name,
      command: sanitizeDiscordOutput(command),
      ok: false,
      exitCode: typeof err.code === "number" ? err.code : undefined,
      output: trimOutput(sanitizeDiscordOutput(`${err.stdout ?? ""}${err.stderr ? `\n${err.stderr}` : ""}` || err.message)),
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } finally {
    await rm(runtimeHome, { force: true, recursive: true });
  }
}

export function formatProjectCommandResult(result: ProjectCommandResult): string {
  const status = result.ok ? "passed" : "failed";
  const exit = result.exitCode === undefined ? "" : `, exit ${result.exitCode}`;
  return [
    `\`${result.kind}\` ${status} for \`${result.projectName}\`${exit}.`,
    `Command: \`${result.command}\``,
    "",
    "Output:",
    codeBlock(result.output || "(no output)")
  ].join("\n");
}

function isProjectCommandKind(value: string): value is ProjectCommandKind {
  return value === "test" || value === "build" || value === "lint" || value === "verify";
}

function trimOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 3_500 ? trimmed : `${trimmed.slice(-3_500)}\n[output truncated to last 3500 chars]`;
}

function codeBlock(value: string): string {
  return `\`\`\`\n${value.replace(/```/g, "'''")}\n\`\`\``;
}
