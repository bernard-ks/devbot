import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { CodexRequestMode } from "./codex-client.js";
import type { ModelTier, RequestContextMode } from "./request-router.js";
import type { ProjectEntry } from "./types.js";

const execFileAsync = promisify(execFile);

export type CodexWorkMode = CodexRequestMode | "session";
export type CodexWorkSource = "bot" | "local-codex";
export type WorkPhase = "routing" | "gathering-context" | "running-codex";

export interface ActiveWork {
  id: string;
  mode: CodexWorkMode;
  source: CodexWorkSource;
  projectName: string;
  requester: string;
  text: string;
  startedAt: Date;
  pid?: number;
  taskId?: string;
  phase?: WorkPhase;
  modelTier?: ModelTier;
  contextMode?: RequestContextMode;
  contextFileCount?: number;
}

export interface StartWorkInput {
  mode: CodexRequestMode;
  projectName: string;
  requester: string;
  text: string;
  taskId?: string;
}

export interface WorkProgressUpdate {
  phase?: WorkPhase;
  modelTier?: ModelTier;
  contextMode?: RequestContextMode;
  contextFileCount?: number;
}

export interface ProjectWorkSnapshot {
  projectName: string;
  branch: string;
  defaultBranch: string;
  status: string;
  diffStat: string;
  lastCommit: string;
}

export function filterWorkForProjects(activeWork: ActiveWork[], projects: ProjectEntry[]): ActiveWork[] {
  const visibleProjectNames = new Set(projects.map((project) => project.name));
  return activeWork.filter((work) => visibleProjectNames.has(work.projectName));
}

export class WorkTracker {
  private nextId = 1;
  private readonly active = new Map<string, ActiveWork>();

  start(input: StartWorkInput): ActiveWork {
    const work: ActiveWork = {
      id: String(this.nextId++),
      source: "bot",
      ...input,
      phase: "routing",
      startedAt: new Date()
    };
    this.active.set(work.id, work);
    return work;
  }

  update(id: string, progress: WorkProgressUpdate): ActiveWork | undefined {
    const work = this.active.get(id);
    if (!work) {
      return undefined;
    }

    Object.assign(work, progress);
    return work;
  }

  finish(id: string): void {
    this.active.delete(id);
  }

  snapshot(): ActiveWork[] {
    return [...this.active.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
}

export function formatWorkStatus(
  activeWork: ActiveWork[],
  now = new Date(),
  projectSnapshots: ProjectWorkSnapshot[] = []
): string {
  const botWork = activeWork.filter((work) => work.source === "bot");
  const externalRuns = activeWork.filter((work) => work.source === "local-codex" && work.mode !== "session");
  const openSessions = activeWork.filter((work) => work.source === "local-codex" && work.mode === "session");
  const confirmedWork = [...botWork, ...externalRuns];
  const lines = [
    "**Development status**",
    `Devbot tasks: ${botWork.length} | External runs: ${externalRuns.length} | Open sessions: ${openSessions.length}`,
    "",
    "**Now**"
  ];

  if (confirmedWork.length === 0) {
    lines.push("No Devbot-managed task or external Codex command is confirmed running.");
  } else {
    lines.push(...confirmedWork.map((work) => formatConfirmedWork(work, now)));
  }

  if (openSessions.length > 0) {
    lines.push("", "**Open sessions (activity unknown)**", ...openSessions.map((work) => formatOpenSession(work, now)));
  }

  if (projectSnapshots.length > 0) {
    lines.push("", "**Repository evidence**", ...projectSnapshots.map(formatProjectSnapshot));
  }

  lines.push(
    "",
    "**Blockers and risks**",
    ...formatRisks(activeWork, projectSnapshots, now),
    "",
    "**Best next step**",
    formatNextStep(botWork, externalRuns, openSessions, projectSnapshots, now)
  );

  return lines.join("\n");
}

function formatConfirmedWork(work: ActiveWork, now: Date): string {
  const elapsed = formatElapsed(now.getTime() - work.startedAt.getTime());
  if (work.source === "local-codex") {
    const access = work.mode === "action" ? "write-capable" : "read-only";
    return `- \`${inlineCode(work.projectName)}\`: external Codex ${access} run for ${elapsed}. Its exact request and phase are not shared with Devbot.`;
  }

  const task = work.taskId ? ` Task \`${inlineCode(work.taskId)}\`.` : "";
  return `- \`${inlineCode(work.projectName)}\`: \`${inlineCode(truncate(work.text, 160))}\`\n  Phase: ${formatWorkPhase(work)} | ${elapsed} | requested by ${safePlainText(work.requester)}.${task}`;
}

function formatOpenSession(work: ActiveWork, now: Date): string {
  const elapsed = formatElapsed(now.getTime() - work.startedAt.getTime());
  return `- \`${inlineCode(work.projectName)}\`: Codex app session open ${elapsed}. Open does not prove active work; it may be working, waiting, or idle.`;
}

function formatWorkPhase(work: ActiveWork): string {
  if (work.phase === "routing") {
    return "choosing Luna, Terra, or Sol";
  }

  const model = work.modelTier ? modelTierName(work.modelTier) : "Codex";
  if (work.phase === "gathering-context") {
    const context = work.contextMode ?? "project";
    return `reading ${context} context for ${model}`;
  }

  if (work.phase === "running-codex") {
    const files = work.contextFileCount === undefined
      ? ""
      : ` with ${work.contextFileCount} context ${work.contextFileCount === 1 ? "file" : "files"}`;
    return `${model} is working${files}`;
  }

  return "starting";
}

function modelTierName(tier: ModelTier): "Luna" | "Terra" | "Sol" {
  return tier === "fast" ? "Luna" : tier === "standard" ? "Terra" : "Sol";
}

function formatProjectSnapshot(snapshot: ProjectWorkSnapshot): string {
  const statusUnavailable = snapshot.status.startsWith("Unable to read status:");
  const branch = snapshot.branch === "unknown" ? "branch unknown" : `branch \`${inlineCode(snapshot.branch)}\``;
  const lastCommit = snapshot.lastCommit === "unknown"
    ? "last commit unavailable"
    : `last commit \`${inlineCode(truncate(snapshot.lastCommit, 90))}\``;

  if (statusUnavailable) {
    return `- \`${inlineCode(snapshot.projectName)}\`: ${branch}; working-tree state unavailable; ${lastCommit}.`;
  }

  const paths = changedPaths(snapshot.status);
  if (paths.length === 0) {
    return `- \`${inlineCode(snapshot.projectName)}\`: ${branch}; working tree clean; ${lastCommit}.`;
  }

  const visiblePaths = paths.slice(0, 4).map(formatChangedPath);
  const remainder = paths.length > visiblePaths.length ? `, +${paths.length - visiblePaths.length} more` : "";
  const diffSummary = formatDiffSummary(snapshot.diffStat);
  const scope = diffSummary ? `; \`${inlineCode(diffSummary)}\`` : "";
  return `- \`${inlineCode(snapshot.projectName)}\`: ${branch}; ${paths.length} changed ${paths.length === 1 ? "path" : "paths"}: ${visiblePaths.join(", ")}${remainder}${scope}; ${lastCommit}.`;
}

function formatRisks(activeWork: ActiveWork[], snapshots: ProjectWorkSnapshot[], now: Date): string[] {
  const risks: string[] = [];
  const workByProject = new Map<string, number>();
  for (const work of activeWork) {
    workByProject.set(work.projectName, (workByProject.get(work.projectName) ?? 0) + 1);
  }

  for (const [projectName, count] of workByProject) {
    if (count > 1) {
      risks.push(`- Overlap risk: ${count} active or open Codex contexts point at \`${inlineCode(projectName)}\`.`);
    }
  }

  const openSessions = activeWork.filter((work) => work.source === "local-codex" && work.mode === "session");
  for (const work of openSessions) {
    const elapsed = formatElapsed(now.getTime() - work.startedAt.getTime());
    risks.push(
      `- Visibility gap: \`${inlineCode(work.projectName)}\` has an external session open ${elapsed}; Devbot cannot tell whether it is progressing, blocked, or idle.`
    );
  }

  const externalRuns = activeWork.filter((work) => work.source === "local-codex" && work.mode !== "session");
  for (const work of externalRuns) {
    risks.push(`- Visibility gap: Devbot cannot read progress or blocker details for the external \`${inlineCode(work.projectName)}\` run.`);
  }

  for (const snapshot of snapshots) {
    const paths = changedPaths(snapshot.status);
    if (paths.length > 0 && snapshot.branch === snapshot.defaultBranch) {
      risks.push(
        `- Branch risk: \`${inlineCode(snapshot.projectName)}\` has uncommitted work on its default branch \`${inlineCode(snapshot.defaultBranch)}\`.`
      );
    }
    if (paths.length > 25) {
      risks.push(`- Scope risk: \`${inlineCode(snapshot.projectName)}\` has ${paths.length} changed paths; review scope before adding overlapping work.`);
    }
  }

  return risks.length > 0 ? risks : ["- No explicit blocker is visible from Devbot or the repository."];
}

function formatNextStep(
  botWork: ActiveWork[],
  externalRuns: ActiveWork[],
  openSessions: ActiveWork[],
  snapshots: ProjectWorkSnapshot[],
  now: Date
): string {
  const overlappingProject = findOverlappingProject([...botWork, ...externalRuns, ...openSessions]);
  if (overlappingProject) {
    return `Pause new work on \`${inlineCode(overlappingProject)}\` and get a checkpoint from each context: \`completed / in progress / blocked / next\`.`;
  }

  const oldestSession = [...openSessions].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
  if (oldestSession) {
    const elapsed = formatElapsed(now.getTime() - oldestSession.startedAt.getTime());
    const snapshot = snapshots.find((item) => item.projectName === oldestSession.projectName);
    const review = snapshot && changedPaths(snapshot.status).length > 0
      ? ` Then inspect the current diff with \`/review packet project:${inlineCode(oldestSession.projectName)}\` before assigning overlapping work.`
      : "";
    return `Ask the \`${inlineCode(oldestSession.projectName)}\` Codex session for a checkpoint after ${elapsed}: \`completed / in progress / blocked / next\`.${review}`;
  }

  const externalRun = externalRuns[0];
  if (externalRun) {
    return `Inspect \`${inlineCode(externalRun.projectName)}\` with \`/review packet project:${inlineCode(externalRun.projectName)}\`, then ask the external run for a checkpoint before assigning overlapping work.`;
  }

  const botTask = botWork[0];
  if (botTask) {
    return botTask.taskId
      ? `Let the current task continue and track it with \`/task status id:${inlineCode(botTask.taskId)}\`. Cancel it only if priorities changed.`
      : "Let the current Devbot task continue; avoid assigning overlapping work until it finishes.";
  }

  const dirtySnapshot = snapshots.find((snapshot) => changedPaths(snapshot.status).length > 0);
  if (dirtySnapshot) {
    return `No work is confirmed running. Review the existing changes with \`/review packet project:${inlineCode(dirtySnapshot.projectName)}\` before choosing the next task.`;
  }

  return "Ready for the next assignment. Use `/task recent` if you want to review what just finished.";
}

function findOverlappingProject(work: ActiveWork[]): string | undefined {
  const counts = new Map<string, number>();
  for (const item of work) {
    const count = (counts.get(item.projectName) ?? 0) + 1;
    if (count > 1) {
      return item.projectName;
    }
    counts.set(item.projectName, count);
  }
  return undefined;
}

function changedPaths(status: string): string[] {
  if (!status.trim() || status.startsWith("Unable to read status:")) {
    return [];
  }

  return status
    .split(/\r?\n/)
    .map((line) => line.length >= 4 ? line.slice(3).trim() : "")
    .filter(Boolean);
}

function formatChangedPath(value: string): string {
  if (isSensitivePath(value)) {
    return "`[sensitive path hidden]`";
  }
  return `\`${inlineCode(truncate(value, 72))}\``;
}

function isSensitivePath(value: string): boolean {
  return value.split(" -> ").some((candidate) => {
    const cleaned = candidate.replace(/^"|"$/g, "");
    const baseName = cleaned.split(/[\\/]/).at(-1) ?? cleaned;
    return (
      baseName.toLowerCase().startsWith(".env") ||
      /(?:secret|credential|password|private[_-]?key|api[_-]?key|access[_-]?token)/i.test(baseName) ||
      /^id_rsa(?:\.|$)/i.test(baseName) ||
      /\.(?:pem|p12|pfx)$/i.test(baseName)
    );
  });
}

function formatDiffSummary(diffStat: string): string | undefined {
  const summary = diffStat.trim().split(/\r?\n/).at(-1)?.trim();
  return summary && /files? changed/.test(summary) ? truncate(summary, 100) : undefined;
}

function safePlainText(value: string): string {
  return truncate(value, 80).replace(/@/g, "@\u200b").replace(/[\r\n]+/g, " ");
}

function inlineCode(value: string): string {
  return value.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
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

  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
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
