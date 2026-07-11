import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configuredCommandNames, formatProjectCommandResult, runConfiguredProjectCommand } from "./command-runner.js";
import type { ProjectCommandResult } from "./command-runner.js";
import { hardenedGitArguments, hardenedGitEnvironment, redactSensitiveText, sanitizeDiscordOutput } from "./security.js";
import type { TaskRecord } from "./task-store.js";
import type { ProjectEntry } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ReviewPacket {
  project: ProjectEntry;
  task: TaskRecord | undefined;
  branch: string;
  defaultBranch: string;
  status: string;
  diffStat: string;
  lastCommit: string;
}

export interface MergeGateResult {
  ok: boolean;
  cleanWorkingTree: boolean;
  validation: ProjectCommandResult[];
}

export async function createReviewPacket(project: ProjectEntry, task?: TaskRecord): Promise<ReviewPacket> {
  const [branch, status, diffStat, lastCommit] = await Promise.all([
    git(project, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "unknown"),
    git(project, ["status", "--short", "--untracked-files=all", "--ignore-submodules=all"])
      .catch((error) => `Unable to read status: ${sanitizeDiscordOutput((error as Error).message)}`),
    git(project, ["diff", "--stat", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD"]).catch(() => ""),
    git(project, ["log", "--no-show-signature", "-1", "--oneline"]).catch(() => "unknown")
  ]);

  return {
    project,
    task,
    branch: branch.trim() || "unknown",
    defaultBranch: project.metadata.defaultBranch ?? "main",
    status: status.trim(),
    diffStat: diffStat.trim(),
    lastCommit: lastCommit.trim()
  };
}

export async function validateReview(project: ProjectEntry, commandNames?: string[]): Promise<ProjectCommandResult[]> {
  const names = commandNames?.length ? commandNames : defaultValidationCommands(project);
  if (names.length === 0) {
    throw new Error(`No validation commands configured for ${project.name}. Add test/build/lint/verify to .devbot/project.json.`);
  }

  const results: ProjectCommandResult[] = [];
  for (const name of names) {
    results.push(await runConfiguredProjectCommand(project, name));
  }
  return results;
}

export async function evaluateMergeGates(project: ProjectEntry, commandNames?: string[]): Promise<MergeGateResult> {
  const status = await git(project, ["status", "--short", "--untracked-files=all", "--ignore-submodules=all"]).catch(() => "unknown");
  const cleanWorkingTree = status.trim().length === 0;
  const validation = await validateReview(project, commandNames);
  return {
    ok: cleanWorkingTree && validation.every((result) => result.ok),
    cleanWorkingTree,
    validation
  };
}

export function formatReviewPacket(packet: ReviewPacket): string {
  const lines = [
    `Review packet for \`${packet.project.name}\``,
    `Branch: \`${packet.branch}\``,
    `Default branch: \`${packet.defaultBranch}\``,
    `Last commit: \`${packet.lastCommit}\``,
    packet.project.metadata.repoUrl ? `Repo: ${packet.project.metadata.repoUrl}` : undefined,
    packet.task ? `Task: \`${packet.task.id}\` (${packet.task.status})` : undefined,
    packet.task ? `Task request: ${truncate(packet.task.text, 500)}` : undefined,
    "",
    "Changed files:",
    codeBlock(packet.status || "(working tree clean)"),
    "",
    "Diff stat:",
    codeBlock(packet.diffStat || "(no diff against HEAD)"),
    "",
    "Suggested verification:",
    configuredCommandNames(packet.project).length > 0
      ? configuredCommandNames(packet.project).map((name) => `- \`${name}\``).join("\n")
      : "- No project validation commands configured yet."
  ];

  return sanitizeDiscordOutput(lines.filter((line) => line !== undefined).join("\n"));
}

export function formatValidationResults(project: ProjectEntry, results: ProjectCommandResult[]): string {
  return sanitizeDiscordOutput([
    `Validation for \`${project.name}\`: ${results.every((result) => result.ok) ? "passed" : "failed"}`,
    "",
    ...results.map(formatProjectCommandResult)
  ].join("\n\n"));
}

export function formatMergeGateResult(project: ProjectEntry, result: MergeGateResult): string {
  return sanitizeDiscordOutput([
    `Merge gates for \`${project.name}\`: ${result.ok ? "passed" : "blocked"}`,
    `Clean working tree: ${result.cleanWorkingTree ? "yes" : "no"}`,
    `Validation: ${result.validation.every((item) => item.ok) ? "passed" : "failed"}`,
    "",
    ...result.validation.map(formatProjectCommandResult)
  ].join("\n\n"));
}

function defaultValidationCommands(project: ProjectEntry): string[] {
  const commands = project.metadata.commands;
  if (commands.verify.length > 0) {
    return ["verify"];
  }

  return (["lint", "build", "test"] as const).filter((name) => commands[name].length > 0);
}

async function git(project: ProjectEntry, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", hardenedGitArguments(project.root, args), {
    timeout: 30_000,
    maxBuffer: 1_000_000,
    env: hardenedGitEnvironment()
  });
  return redactSensitiveText(`${stdout}${stderr ? `\n${stderr}` : ""}`);
}

function codeBlock(value: string): string {
  return `\`\`\`\n${value.replace(/```/g, "'''")}\n\`\`\``;
}

function truncate(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}...`;
}
