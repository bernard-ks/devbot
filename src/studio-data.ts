import type { ReviewPacket } from "./review.js";
import { redactSensitiveText } from "./security.js";
import type { TaskRecord } from "./task-store.js";

export type StudioLane = "needs-me" | "in-flight" | "recent";
export type StudioAgentStatus = "active" | "waiting" | "ready";

export interface StudioTask {
  id: string;
  project: string;
  title: string;
  requester: string;
  status: TaskRecord["status"];
  lane: StudioLane;
  updatedAt: string;
  result: string | null;
  error: string | null;
  roles: string[];
  approval: {
    attention: TaskRecord["attention"] | null;
    status: TaskRecord["approvalStatus"] | null;
    actor: string | null;
  };
  branch: {
    name: string | null;
    base: string | null;
    isolated: boolean;
    merged: boolean;
  };
  evidence: {
    changedFiles: string[];
    diffStat: string | null;
    verification: string[];
    captureNote: string | null;
  };
}

export interface StudioProject {
  name: string;
  branch: string;
  defaultBranch: string;
  dirty: boolean;
  changedPaths: string[];
  diffStat: string | null;
  lastCommit: string;
}

export interface StudioAgent {
  id: "coordinator" | "builder" | "reviewer" | "verifier";
  name: string;
  role: string;
  status: StudioAgentStatus;
  taskId: string | null;
  taskTitle: string | null;
}

export interface StudioSnapshot {
  version: 1;
  source: "live" | "demo";
  generatedAt: string;
  bot: {
    name: string;
    owner: string;
    safeMode: boolean;
  };
  totals: {
    needsMe: number;
    inFlight: number;
    recent: number;
    projects: number;
  };
  projects: StudioProject[];
  tasks: StudioTask[];
  agents: StudioAgent[];
}

export interface StudioSnapshotInput {
  generatedAt?: Date;
  source?: "live" | "demo";
  bot: StudioSnapshot["bot"];
  tasks: readonly TaskRecord[];
  reviews: readonly ReviewPacket[];
  privatePaths?: readonly string[];
}

const MAX_TASKS = 18;
const MAX_CHANGED_FILES = 8;
const MAX_VERIFICATION_ITEMS = 6;

export function buildStudioSnapshot(input: StudioSnapshotInput): StudioSnapshot {
  const tasks = input.tasks
    .filter(isStudioTaskVisible)
    .slice(0, MAX_TASKS)
    .map((task) => studioTask(task, input.privatePaths ?? []));
  const projects = input.reviews.map((review) => studioProject(review, input.privatePaths ?? []));

  return {
    version: 1,
    source: input.source ?? "live",
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    bot: input.bot,
    totals: {
      needsMe: tasks.filter((task) => task.lane === "needs-me").length,
      inFlight: tasks.filter((task) => task.lane === "in-flight").length,
      recent: tasks.filter((task) => task.lane === "recent").length,
      projects: projects.length
    },
    projects,
    tasks,
    agents: studioAgents(tasks)
  };
}

export function isStudioTaskVisible(task: TaskRecord): boolean {
  return !task.internal
    && !task.source.startsWith("lab:council:")
    && !task.source.startsWith("workroom:agent:")
    && task.source !== "status-detail";
}

function studioTask(task: TaskRecord, privatePaths: readonly string[]): StudioTask {
  return {
    id: task.id,
    project: compact(task.projectName, 80, privatePaths),
    title: compact(task.text, 240, privatePaths),
    requester: compact(task.requester, 100, privatePaths),
    status: task.status,
    lane: taskLane(task),
    updatedAt: task.updatedAt,
    result: task.resultPreview ? compact(task.resultPreview, 700, privatePaths) : null,
    error: task.error ? compact(task.error, 500, privatePaths) : null,
    roles: [...new Set(task.agentRoles ?? [])].slice(0, 4).map((role) => compact(role, 40, privatePaths)),
    approval: {
      attention: task.attention ?? null,
      status: task.approvalStatus ?? null,
      actor: task.approvalActor ? compact(task.approvalActor, 100, privatePaths) : null
    },
    branch: {
      name: task.branchName ? compact(task.branchName, 180, privatePaths) : null,
      base: task.baseBranch ? compact(task.baseBranch, 180, privatePaths) : null,
      isolated: task.workspaceIsolated === true,
      merged: task.branchMerged === true
    },
    evidence: {
      changedFiles: (task.changedFiles ?? []).slice(0, MAX_CHANGED_FILES).map((file) => compact(file, 180, privatePaths)),
      diffStat: task.diffStat ? compact(task.diffStat, 900, privatePaths) : null,
      verification: (task.verification ?? []).slice(0, MAX_VERIFICATION_ITEMS).map((item) => compact(item, 360, privatePaths)),
      captureNote: task.captureNote ? compact(task.captureNote, 700, privatePaths) : null
    }
  };
}

function studioProject(packet: ReviewPacket, privatePaths: readonly string[]): StudioProject {
  const changedPaths = packet.status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((line) => compact(line, 180, privatePaths));
  return {
    name: compact(packet.project.name, 80, privatePaths),
    branch: compact(packet.branch || "unknown", 180, privatePaths),
    defaultBranch: compact(packet.defaultBranch || "main", 180, privatePaths),
    dirty: changedPaths.length > 0,
    changedPaths,
    diffStat: packet.diffStat ? compact(packet.diffStat, 900, privatePaths) : null,
    lastCommit: compact(packet.lastCommit || "unknown", 240, privatePaths)
  };
}

function studioAgents(tasks: readonly StudioTask[]): StudioAgent[] {
  const running = tasks.filter((task) => task.lane === "in-flight");
  const needsMe = tasks.filter((task) => task.lane === "needs-me");
  return [
    agent("coordinator", "Devbot", "Coordinator", running[0] ?? needsMe[0]),
    agent("builder", "Builder", "Implementation", taskForRole(running, "builder")),
    agent("reviewer", "Reviewer", "Code review", taskForRole(running, "reviewer") ?? needsMe.find((task) => task.approval.attention === "review")),
    agent("verifier", "Verifier", "Proof and checks", taskForRole(running, "verifier") ?? needsMe.find((task) => task.evidence.verification.length > 0))
  ];
}

function agent(
  id: StudioAgent["id"],
  name: string,
  role: string,
  task: StudioTask | undefined
): StudioAgent {
  return {
    id,
    name,
    role,
    status: task ? (task.lane === "in-flight" ? "active" : "waiting") : "ready",
    taskId: task?.id ?? null,
    taskTitle: task?.title ?? null
  };
}

function taskForRole(tasks: readonly StudioTask[], role: string): StudioTask | undefined {
  return tasks.find((task) => task.roles.some((value) => value.toLowerCase() === role));
}

function taskLane(task: TaskRecord): StudioLane {
  if (task.status === "running") return "in-flight";
  if (task.status === "awaiting-approval" || task.attention) return "needs-me";
  return "recent";
}

export function sanitizeStudioText(value: string, privatePaths: readonly string[] = []): string {
  let sanitized = redactSensitiveText(value).replace(/\0/g, "");
  for (const privatePath of [...new Set(privatePaths.map((item) => item.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(privatePath).join("[local path]");
  }
  sanitized = sanitized
    .replace(/(^|[\s`"'(=])\/(?:Users|home|private|var\/folders|tmp|Volumes)\/[^\s`"')\]}>;,]*/g, "$1[local path]")
    .replace(/\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s`"')\]}>;,]*/g, "[local path]")
    .replace(/\bpid\s+\d+\b/gi, "process [redacted]");
  return sanitized;
}

function compact(value: string, maxLength: number, privatePaths: readonly string[] = []): string {
  const normalized = sanitizeStudioText(value, privatePaths).replace(/\s+/g, " ").trim() || "Not provided";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
