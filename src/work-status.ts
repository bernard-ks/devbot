import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { CodexRequestMode } from "./codex-client.js";
import type { ProjectEntry } from "./types.js";

const execFileAsync = promisify(execFile);

export type CodexWorkMode = CodexRequestMode | "session";
export type CodexWorkSource = "bot" | "local-codex";

export interface ActiveWork {
  id: string;
  mode: CodexWorkMode;
  source: CodexWorkSource;
  projectName: string;
  requester: string;
  text: string;
  startedAt: Date;
  pid?: number;
}

export interface StartWorkInput {
  mode: CodexRequestMode;
  projectName: string;
  requester: string;
  text: string;
}

export class WorkTracker {
  private nextId = 1;
  private readonly active = new Map<string, ActiveWork>();

  start(input: StartWorkInput): ActiveWork {
    const work: ActiveWork = {
      id: String(this.nextId++),
      source: "bot",
      ...input,
      startedAt: new Date()
    };
    this.active.set(work.id, work);
    return work;
  }

  finish(id: string): void {
    this.active.delete(id);
  }

  snapshot(): ActiveWork[] {
    return [...this.active.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
}

export function formatWorkStatus(activeWork: ActiveWork[], now = new Date()): string {
  if (activeWork.length === 0) {
    return "No Codex dev work is currently in progress.";
  }

  const lines = activeWork.map((work) => {
    const elapsed = formatElapsed(now.getTime() - work.startedAt.getTime());
    const pid = work.pid ? `, pid ${work.pid}` : "";
    return `- \`${work.projectName}\` ${work.mode} via ${work.source}${pid} for ${work.requester}, running ${elapsed}: ${truncate(work.text, 120)}`;
  });

  return [`Codex dev work currently in progress: ${activeWork.length}`, ...lines].join("\n");
}

export async function findExternalCodexWork(projects: ProjectEntry[], now = new Date()): Promise<ActiveWork[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,etime=,command="], {
      maxBuffer: 2_000_000
    });
    return parseExternalCodexWork(stdout, projects, now);
  } catch {
    return [];
  }
}

export function parseExternalCodexWork(psOutput: string, projects: ProjectEntry[], now = new Date()): ActiveWork[] {
  const work: ActiveWork[] = [];
  const seen = new Set<number>();

  for (const line of psOutput.split("\n")) {
    const parsed = parsePsLine(line);
    if (!parsed || seen.has(parsed.pid) || parsed.command.includes("devbot-codex-")) {
      continue;
    }

    const match = matchCodexProjectProcess(parsed.command, projects);
    if (!match) {
      continue;
    }

    seen.add(parsed.pid);
    work.push({
      id: `process:${parsed.pid}`,
      mode: match.mode,
      source: "local-codex",
      projectName: match.project.name,
      requester: "local Codex",
      text: match.description,
      startedAt: new Date(now.getTime() - parseElapsedToMs(parsed.elapsed)),
      pid: parsed.pid
    });
  }

  return work.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

interface PsLine {
  pid: number;
  elapsed: string;
  command: string;
}

function parsePsLine(line: string): PsLine | undefined {
  const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    pid: Number(match[1]),
    elapsed: match[2] ?? "0:00",
    command: match[3] ?? ""
  };
}

interface ProjectProcessMatch {
  project: ProjectEntry;
  mode: CodexWorkMode;
  description: string;
}

function matchCodexProjectProcess(command: string, projects: ProjectEntry[]): ProjectProcessMatch | undefined {
  const workingDir = extractOption(command, "--cd") ?? extractOption(command, "--working-dir");
  const isCodexExec = /\bcodex exec\b/.test(command);
  const isCodexSession = command.includes("cua_node/bin/node") && command.includes("--working-dir");

  if (!isCodexExec && !isCodexSession) {
    return undefined;
  }

  const project = projects.find((entry) => processBelongsToProject(command, workingDir, entry.root));
  if (!project) {
    return undefined;
  }

  if (isCodexExec) {
    return {
      project,
      mode: command.includes("--sandbox workspace-write") ? "action" : "answer",
      description: "local codex exec process"
    };
  }

  return {
    project,
    mode: "session",
    description: "local Codex app session"
  };
}

function processBelongsToProject(command: string, workingDir: string | undefined, projectRoot: string): boolean {
  const root = path.resolve(projectRoot);
  if (workingDir && isSameOrInside(path.resolve(workingDir), root)) {
    return true;
  }

  return command.includes(root);
}

function extractOption(command: string, option: string): string | undefined {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`${escaped}\\s+([^\\s]+)`));
  return match?.[1];
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseElapsedToMs(elapsed: string): number {
  const dayParts = elapsed.split("-");
  const days = dayParts.length === 2 ? Number(dayParts[0]) || 0 : 0;
  const time = dayParts.length === 2 ? dayParts[1] ?? "0:00" : elapsed;
  const parts = time.split(":").map((part) => Number(part) || 0);
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    hours = parts[0] ?? 0;
    minutes = parts[1] ?? 0;
    seconds = parts[2] ?? 0;
  } else if (parts.length === 2) {
    minutes = parts[0] ?? 0;
    seconds = parts[1] ?? 0;
  } else {
    seconds = parts[0] ?? 0;
  }

  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}
