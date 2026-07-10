import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  redactSensitiveText
} from "./security.js";

export type TaskStatus = "awaiting-approval" | "running" | "succeeded" | "failed" | "canceled";
export type TaskAttention = "approval" | "blocked" | "review";
export type TaskApprovalStatus = "pending" | "approved" | "read-only" | "denied";
export type TaskAccessScope = "project" | "workroom";

const TASK_ID_PATTERN = /^task-[a-z0-9-]{1,52}$/i;

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  source: string;
  mode: string;
  projectName: string;
  requester: string;
  text: string;
  includePatterns: string[];
  parentTaskId?: string;
  dedupeKey?: string;
  requesterId?: string;
  accessScope?: TaskAccessScope;
  internal?: boolean;
  channelId?: string;
  threadId?: string;
  controlMessageId?: string;
  agentRoles?: string[];
  proposalRevision?: number;
  approvedRevision?: number;
  approvalStatus?: TaskApprovalStatus;
  approvalActor?: string;
  attention?: TaskAttention;
  workspacePath?: string;
  branchName?: string;
  baseBranch?: string;
  workspaceIsolated?: boolean;
  branchMerged?: boolean;
  changedFiles?: string[];
  diffStat?: string;
  commitSha?: string;
  verification?: string[];
  contextFileCount?: number;
  model?: string;
  modelTier?: string;
  contextMode?: string;
  routeReason?: string;
  routeSource?: string;
  resultPreview?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface StartTaskInput {
  source: string;
  mode: string;
  projectName: string;
  requester: string;
  text: string;
  includePatterns?: string[];
  parentTaskId?: string;
  dedupeKey?: string;
  requesterId?: string;
  accessScope?: TaskAccessScope;
  internal?: boolean;
  channelId?: string;
  threadId?: string;
  controlMessageId?: string;
  agentRoles?: string[];
}

export interface TaskWorkspaceUpdate {
  workspacePath: string;
  branchName?: string;
  baseBranch?: string;
  isolated: boolean;
}

export interface TaskBranchSyncUpdate {
  merged?: boolean;
  baseBranch?: string;
}

export interface TaskEvidenceUpdate {
  changedFiles?: string[];
  diffStat?: string;
  commitSha?: string;
  verification?: string[];
}

interface TaskStateFile {
  version: 1;
  tasks: TaskRecord[];
}

export class TaskStore {
  private state: TaskStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile = path.resolve(".devbot", "tasks.json"),
    private readonly maxRecords = 500
  ) {}

  async start(input: StartTaskInput): Promise<TaskRecord> {
    return this.mutate((state) => {
      assertTaskCapacity(state.tasks, this.maxRecords);
      if (input.dedupeKey && state.tasks.some((task) => task.dedupeKey === input.dedupeKey)) {
        throw new Error("That task action has already started. Open its child task for the latest state.");
      }
      const now = new Date().toISOString();
      const task = createTaskRecord(input, "running", now);

      state.tasks.unshift(task);
      state.tasks = retainOpenTasks(state.tasks, this.maxRecords);
      return cloneTask(task);
    });
  }

  async propose(input: StartTaskInput): Promise<TaskRecord> {
    return this.mutate((state) => {
      assertTaskCapacity(state.tasks, this.maxRecords);
      if (input.dedupeKey && state.tasks.some((task) => task.dedupeKey === input.dedupeKey)) {
        throw new Error("That task proposal already exists.");
      }
      const now = new Date().toISOString();
      const task = createTaskRecord(input, "awaiting-approval", now);
      task.proposalRevision = 1;
      task.approvalStatus = "pending";
      task.attention = "approval";
      state.tasks.unshift(task);
      state.tasks = retainOpenTasks(state.tasks, this.maxRecords);
      return cloneTask(task);
    });
  }

  async begin(id: string, options: { mode?: string; actor?: string; expectedRevision?: number } = {}): Promise<TaskRecord | undefined> {
    let started: TaskRecord | undefined;
    await this.update(id, (task) => {
      if (task.status !== "awaiting-approval") return;
      if (options.expectedRevision !== undefined && task.proposalRevision !== options.expectedRevision) return;
      task.status = "running";
      task.mode = options.mode ?? task.mode;
      task.approvalStatus = task.mode === "action" ? "approved" : "read-only";
      if (options.actor) task.approvalActor = options.actor;
      if (task.proposalRevision !== undefined) task.approvedRevision = task.proposalRevision;
      delete task.attention;
      started = cloneTask(task);
    });
    return started;
  }

  async deny(id: string, actor: string, expectedRevision?: number): Promise<TaskRecord | undefined> {
    let denied: TaskRecord | undefined;
    await this.update(id, (task, now) => {
      if (task.status !== "awaiting-approval") return;
      if (expectedRevision !== undefined && task.proposalRevision !== expectedRevision) return;
      task.status = "canceled";
      task.approvalStatus = "denied";
      task.approvalActor = actor;
      task.error = `Declined by ${actor}.`;
      task.finishedAt = now;
      delete task.attention;
      denied = cloneTask(task);
    });
    return denied;
  }

  async updateProposal(
    id: string,
    input: { text?: string; agentRoles?: string[]; expectedRevision?: number }
  ): Promise<TaskRecord | undefined> {
    let updated: TaskRecord | undefined;
    await this.update(id, (task) => {
      if (task.status !== "awaiting-approval") return;
      if (input.expectedRevision !== undefined && task.proposalRevision !== input.expectedRevision) return;
      let changed = false;
      if (input.text?.trim()) {
        const text = redactSensitiveText(input.text.trim());
        if (text !== task.text) {
          task.text = text;
          changed = true;
        }
      }
      if (input.agentRoles) {
        const roles = normalizedStrings(input.agentRoles);
        if (JSON.stringify(roles) !== JSON.stringify(task.agentRoles ?? [])) {
          task.agentRoles = roles;
          changed = true;
        }
      }
      if (changed) task.proposalRevision = (task.proposalRevision ?? 1) + 1;
      updated = cloneTask(task);
    });
    return updated;
  }

  async setDiscordContext(
    id: string,
    input: { channelId?: string; threadId?: string; controlMessageId?: string }
  ): Promise<TaskRecord | undefined> {
    let updated: TaskRecord | undefined;
    await this.update(id, (task) => {
      if (input.channelId) task.channelId = input.channelId;
      if (input.threadId) task.threadId = input.threadId;
      if (input.controlMessageId) task.controlMessageId = input.controlMessageId;
      updated = cloneTask(task);
    });
    return updated;
  }

  async setWorkspace(id: string, input: TaskWorkspaceUpdate): Promise<TaskRecord | undefined> {
    let updated: TaskRecord | undefined;
    await this.update(id, (task) => {
      task.workspacePath = input.workspacePath;
      task.workspaceIsolated = input.isolated;
      if (input.branchName) task.branchName = input.branchName;
      if (input.baseBranch) task.baseBranch = input.baseBranch;
      updated = cloneTask(task);
    });
    return updated;
  }

  async setBranchSync(id: string, input: TaskBranchSyncUpdate): Promise<TaskRecord | undefined> {
    let updated: TaskRecord | undefined;
    await this.update(id, (task) => {
      if (input.merged === true) task.branchMerged = true;
      else if (input.merged === false) delete task.branchMerged;
      if (input.baseBranch) task.baseBranch = redactSensitiveText(input.baseBranch);
      updated = cloneTask(task);
    });
    return updated;
  }

  async setEvidence(id: string, input: TaskEvidenceUpdate): Promise<TaskRecord | undefined> {
    let updated: TaskRecord | undefined;
    await this.update(id, (task) => {
      if (input.changedFiles) task.changedFiles = normalizedStrings(input.changedFiles).map((value) => redactSensitiveText(value));
      if (input.diffStat !== undefined) task.diffStat = redactSensitiveText(input.diffStat);
      if (input.commitSha !== undefined) task.commitSha = redactSensitiveText(input.commitSha);
      if (input.verification) task.verification = normalizedStrings(input.verification).map((value) => redactSensitiveText(value));
      updated = cloneTask(task);
    });
    return updated;
  }

  async markReviewed(id: string): Promise<TaskRecord | undefined> {
    let updated: TaskRecord | undefined;
    await this.update(id, (task) => {
      if (task.attention === "review") delete task.attention;
      updated = cloneTask(task);
    });
    return updated;
  }

  async succeed(id: string, result: {
    contextFileCount?: number;
    resultPreview?: string;
    model?: string;
    modelTier?: string;
    contextMode?: string;
    routeReason?: string;
    routeSource?: string;
  }): Promise<boolean> {
    let transitioned = false;
    await this.update(id, (task, now) => {
      if (task.status !== "running") {
        return;
      }
      transitioned = true;
      task.status = "succeeded";
      if (result.contextFileCount !== undefined) {
        task.contextFileCount = result.contextFileCount;
      }
      if (result.resultPreview !== undefined) {
        task.resultPreview = redactSensitiveText(result.resultPreview);
      }
      if (result.model !== undefined) task.model = redactSensitiveText(result.model);
      if (result.modelTier !== undefined) task.modelTier = redactSensitiveText(result.modelTier);
      if (result.contextMode !== undefined) task.contextMode = redactSensitiveText(result.contextMode);
      if (result.routeReason !== undefined) task.routeReason = redactSensitiveText(result.routeReason);
      if (result.routeSource !== undefined) task.routeSource = redactSensitiveText(result.routeSource);
      if (task.mode === "action") {
        task.attention = "review";
      } else {
        delete task.attention;
      }
      task.finishedAt = now;
    });
    return transitioned;
  }

  async fail(id: string, error: unknown): Promise<boolean> {
    let transitioned = false;
    await this.update(id, (task, now) => {
      if (task.status !== "running") {
        return;
      }
      transitioned = true;
      task.status = "failed";
      task.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
      task.attention = "blocked";
      task.finishedAt = now;
    });
    return transitioned;
  }

  async cancel(id: string, reason = "Canceled by user request."): Promise<TaskRecord | undefined> {
    let canceled: TaskRecord | undefined;
    await this.update(id, (task, now) => {
      if (task.status !== "running") {
        canceled = cloneTask(task);
        return;
      }

      task.status = "canceled";
      task.error = redactSensitiveText(reason);
      task.attention = "blocked";
      task.finishedAt = now;
      canceled = cloneTask(task);
    });
    return canceled;
  }

  async interruptRunning(reason = "Interrupted when Devbot restarted."): Promise<number> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      let interrupted = 0;
      for (const task of state.tasks) {
        if (task.status !== "running") {
          continue;
        }
        task.status = "canceled";
        task.error = reason;
        task.attention = "blocked";
        task.finishedAt = now;
        task.updatedAt = now;
        interrupted += 1;
      }
      return interrupted;
    });
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    const state = await this.readState();
    const task = state.tasks.find((item) => item.id === id);
    return task ? cloneTask(task) : undefined;
  }

  async findByThread(threadId: string): Promise<TaskRecord | undefined> {
    const state = await this.readState();
    const task = state.tasks.find((item) => item.threadId === threadId);
    return task ? cloneTask(task) : undefined;
  }

  async listNeedsAttention(options: { limit?: number; projectName?: string; requesterId?: string } = {}): Promise<TaskRecord[]> {
    const state = await this.readState();
    const limit = Math.max(1, Math.min(options.limit ?? 25, 50));
    return state.tasks
      .filter((task) => Boolean(task.attention))
      .filter((task) => !options.projectName || task.projectName === options.projectName)
      .filter((task) => !options.requesterId || task.requesterId === options.requesterId)
      .slice(0, limit)
      .map(cloneTask);
  }

  async listRecent(options: { limit?: number; projectName?: string; status?: TaskStatus } = {}): Promise<TaskRecord[]> {
    const state = await this.readState();
    const limit = Math.max(1, Math.min(options.limit ?? 10, 25));
    return state.tasks
      .filter((task) => !options.projectName || task.projectName === options.projectName)
      .filter((task) => !options.status || task.status === options.status)
      .slice(0, limit)
      .map(cloneTask);
  }

  private async update(id: string, apply: (task: TaskRecord, now: string) => void): Promise<void> {
    await this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) {
        return;
      }

      const now = new Date().toISOString();
      apply(task, now);
      task.updatedAt = now;
    });
  }

  private async readState(): Promise<TaskStateFile> {
    await this.mutationTail;
    return this.load();
  }

  private async mutate<T>(mutation: (state: TaskStateFile) => T): Promise<T> {
    let result: T | undefined;
    const operation = this.mutationTail.then(async () => {
      const state = await this.load();
      const previous = structuredClone(state);
      result = mutation(state);
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.mutationTail = operation.catch(() => undefined);
    await operation;
    return result as T;
  }

  private async load(): Promise<TaskStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown;
      await hardenPrivateFilePermissions(this.stateFile);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Task state must be a JSON object.");
      }
      const raw = parsed as { version?: unknown; tasks?: unknown };
      if (raw.version !== undefined && raw.version !== 1) {
        throw new Error(`Unsupported task state version: ${String(raw.version)}.`);
      }
      this.state = {
        version: 1,
        tasks: Array.isArray(raw.tasks) ? raw.tasks.map(normalizeLoadedTask).filter((task) => task !== undefined) : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read task state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = { version: 1, tasks: [] };
    }

    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) {
      return;
    }

    const directory = path.dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await hardenPrivateDirectoryPermissions(directory);
    const tempFile = `${this.stateFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    await rename(tempFile, this.stateFile);
  }
}

function assertTaskCapacity(tasks: TaskRecord[], maxRecords: number): void {
  const openTasks = tasks.filter((task) => task.status === "running" || task.status === "awaiting-approval").length;
  if (openTasks >= maxRecords) {
    throw new Error("Devbot's active task limit has been reached. Finish, cancel, or decline existing work before starting more.");
  }
}

function retainOpenTasks(tasks: TaskRecord[], maxRecords: number): TaskRecord[] {
  const openCount = tasks.filter((task) => task.status === "running" || task.status === "awaiting-approval").length;
  let finishedBudget = Math.max(0, maxRecords - openCount);
  return tasks.filter((task) => {
    if (task.status === "running" || task.status === "awaiting-approval") {
      return true;
    }
    if (finishedBudget <= 0) {
      return false;
    }
    finishedBudget -= 1;
    return true;
  });
}

export function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "No saved tasks found.";
  }

  return tasks
    .map((task) => {
      const finished = task.finishedAt ? `, finished ${formatTime(task.finishedAt)}` : "";
      const route = task.modelTier ? `, ${task.modelTier}/${task.contextMode ?? "unknown"}` : "";
      const merged = task.branchMerged ? " (branch merged)" : "";
      return `- \`${task.id}\` ${task.status}${merged} ${task.mode}${route} via ${task.source} on \`${task.projectName}\` for ${task.requester}${finished}: ${truncate(task.text, 90)}`;
    })
    .join("\n");
}

export function formatTaskLogs(task: TaskRecord): string {
  return [
    `Task \`${task.id}\` logs`,
    `Status: ${task.status}`,
    task.modelTier ? `Route: ${task.modelTier} / ${task.contextMode ?? "unknown"} via ${task.routeSource ?? "unknown"}` : undefined,
    task.model ? `Model: ${task.model}` : undefined,
    task.routeReason ? `Reason: ${task.routeReason}` : undefined,
    "",
    "Request:",
    truncate(task.text, 1_500),
    task.resultPreview ? ["", "Result:", truncate(task.resultPreview, 2_000)].join("\n") : undefined,
    task.error ? ["", "Error:", truncate(task.error, 2_000)].join("\n") : undefined
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function formatTaskDetail(task: TaskRecord): string {
  return [
    `Task \`${task.id}\``,
    `Status: ${task.status}`,
    `Project: \`${task.projectName}\``,
    `Mode: ${task.mode} via ${task.source}`,
    task.modelTier ? `Route: ${task.modelTier} / ${task.contextMode ?? "unknown"} via ${task.routeSource ?? "unknown"}` : undefined,
    task.model ? `Model: ${task.model}` : undefined,
    task.routeReason ? `Route reason: ${task.routeReason}` : undefined,
    task.parentTaskId ? `Continues task: \`${task.parentTaskId}\`` : undefined,
    task.attention ? `Needs attention: ${task.attention}` : undefined,
    task.approvalStatus ? `Approval: ${task.approvalStatus}${task.approvalActor ? ` by ${task.approvalActor}` : ""}` : undefined,
    task.proposalRevision ? `Proposal revision: ${task.proposalRevision}${task.approvedRevision ? ` (approved r${task.approvedRevision})` : ""}` : undefined,
    task.agentRoles?.length ? `Workroom roles: ${task.agentRoles.join(", ")}` : undefined,
    task.branchName ? `Branch: \`${task.branchName}\`${task.workspaceIsolated ? " (isolated)" : ""}${task.branchMerged ? ", merged into the default branch" : ""}` : undefined,
    task.branchMerged && task.workspaceIsolated ? "Worktree: eligible for pruning; the branch is fully merged." : undefined,
    task.baseBranch ? `Base revision: \`${task.baseBranch}\`` : undefined,
    task.commitSha ? `Commit: \`${task.commitSha}\`` : undefined,
    `Requester: ${task.requester}`,
    `Started: ${formatTime(task.startedAt)}`,
    task.finishedAt ? `Finished: ${formatTime(task.finishedAt)}` : undefined,
    task.contextFileCount !== undefined ? `Context files: ${task.contextFileCount}` : undefined,
    task.includePatterns.length > 0 ? `Include: \`${task.includePatterns.join(", ")}\`` : undefined,
    task.changedFiles?.length ? `Changed files: ${task.changedFiles.map((file) => `\`${file}\``).join(", ")}` : undefined,
    task.diffStat ? `Diff: ${task.diffStat}` : undefined,
    task.verification?.length ? ["", "Verification:", ...task.verification.map((item) => `- ${item}`)].join("\n") : undefined,
    "",
    "Request:",
    truncate(task.text, 800),
    task.resultPreview ? ["", "Result preview:", truncate(task.resultPreview, 1_200)].join("\n") : undefined,
    task.error ? ["", "Error:", truncate(task.error, 1_200)].join("\n") : undefined
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function createTaskRecord(input: StartTaskInput, status: TaskStatus, now: string): TaskRecord {
  const agentRoles = normalizedStrings(input.agentRoles ?? []);
  return {
    id: newTaskId(),
    status,
    source: input.source,
    mode: input.mode,
    projectName: input.projectName,
    requester: input.requester,
    text: redactSensitiveText(input.text),
    includePatterns: normalizedStrings(input.includePatterns ?? []),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.requesterId ? { requesterId: input.requesterId } : {}),
    ...(input.accessScope ? { accessScope: input.accessScope } : {}),
    ...(input.internal ? { internal: true } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.controlMessageId ? { controlMessageId: input.controlMessageId } : {}),
    ...(agentRoles.length > 0 ? { agentRoles } : {}),
    startedAt: now,
    updatedAt: now
  };
}

function cloneTask(task: TaskRecord): TaskRecord {
  const { agentRoles, changedFiles, verification, ...base } = task;
  return {
    ...base,
    includePatterns: [...task.includePatterns],
    ...(agentRoles ? { agentRoles: [...agentRoles] } : {}),
    ...(changedFiles ? { changedFiles: [...changedFiles] } : {}),
    ...(verification ? { verification: [...verification] } : {})
  };
}

function normalizedStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function normalizeLoadedTask(value: unknown): TaskRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const task = value as Partial<TaskRecord>;
  if (
    typeof task.id !== "string" ||
    !isTaskId(task.id) ||
    typeof task.source !== "string" ||
    typeof task.mode !== "string" ||
    typeof task.projectName !== "string" ||
    typeof task.requester !== "string" ||
    typeof task.text !== "string"
  ) {
    return undefined;
  }

  const statuses: TaskStatus[] = ["awaiting-approval", "running", "succeeded", "failed", "canceled"];
  const status = statuses.includes(task.status as TaskStatus) ? (task.status as TaskStatus) : "canceled";
  const startedAt = validTimestamp(task.startedAt) ?? new Date(0).toISOString();
  const normalizedAgentRoles = Array.isArray(task.agentRoles) ? normalizedStrings(task.agentRoles) : [];
  const normalizedChangedFiles = Array.isArray(task.changedFiles) ? normalizedStrings(task.changedFiles) : [];
  const normalizedVerification = Array.isArray(task.verification) ? normalizedStrings(task.verification) : [];
  const attention = oneOf(task.attention, ["approval", "blocked", "review"] as const);
  const approvalStatus = oneOf(task.approvalStatus, ["pending", "approved", "read-only", "denied"] as const);
  const proposalRevision = positiveInteger(task.proposalRevision) ?? (status === "awaiting-approval" ? 1 : undefined);
  const approvedRevision = positiveInteger(task.approvedRevision);
  const accessScope = oneOf(task.accessScope, ["project", "workroom"] as const);
  return {
    id: task.id,
    status,
    source: task.source,
    mode: task.mode,
    projectName: task.projectName,
    requester: task.requester,
    text: redactSensitiveText(task.text),
    includePatterns: Array.isArray(task.includePatterns) ? normalizedStrings(task.includePatterns) : [],
    ...(stringValue(task.parentTaskId) ? { parentTaskId: stringValue(task.parentTaskId)! } : {}),
    ...(stringValue(task.dedupeKey) ? { dedupeKey: stringValue(task.dedupeKey)! } : {}),
    ...(stringValue(task.requesterId) ? { requesterId: stringValue(task.requesterId)! } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(task.internal === true ? { internal: true } : {}),
    ...(stringValue(task.channelId) ? { channelId: stringValue(task.channelId)! } : {}),
    ...(stringValue(task.threadId) ? { threadId: stringValue(task.threadId)! } : {}),
    ...(stringValue(task.controlMessageId) ? { controlMessageId: stringValue(task.controlMessageId)! } : {}),
    ...(normalizedAgentRoles.length > 0 ? { agentRoles: normalizedAgentRoles } : {}),
    ...(proposalRevision ? { proposalRevision } : {}),
    ...(approvedRevision ? { approvedRevision } : {}),
    ...(approvalStatus ? { approvalStatus } : {}),
    ...(stringValue(task.approvalActor) ? { approvalActor: stringValue(task.approvalActor)! } : {}),
    ...(attention ? { attention } : {}),
    ...(stringValue(task.workspacePath) ? { workspacePath: stringValue(task.workspacePath)! } : {}),
    ...(stringValue(task.branchName) ? { branchName: stringValue(task.branchName)! } : {}),
    ...(stringValue(task.baseBranch) ? { baseBranch: stringValue(task.baseBranch)! } : {}),
    ...(typeof task.workspaceIsolated === "boolean" ? { workspaceIsolated: task.workspaceIsolated } : {}),
    ...(task.branchMerged === true ? { branchMerged: true } : {}),
    ...(normalizedChangedFiles.length > 0 ? { changedFiles: normalizedChangedFiles } : {}),
    ...(stringValue(task.diffStat) ? { diffStat: stringValue(task.diffStat)! } : {}),
    ...(stringValue(task.commitSha) ? { commitSha: stringValue(task.commitSha)! } : {}),
    ...(normalizedVerification.length > 0 ? { verification: normalizedVerification } : {}),
    ...(typeof task.contextFileCount === "number" && Number.isInteger(task.contextFileCount) && task.contextFileCount >= 0
      ? { contextFileCount: task.contextFileCount }
      : {}),
    ...(stringValue(task.model) ? { model: stringValue(task.model)! } : {}),
    ...(stringValue(task.modelTier) ? { modelTier: stringValue(task.modelTier)! } : {}),
    ...(stringValue(task.contextMode) ? { contextMode: stringValue(task.contextMode)! } : {}),
    ...(stringValue(task.routeReason) ? { routeReason: stringValue(task.routeReason)! } : {}),
    ...(stringValue(task.routeSource) ? { routeSource: stringValue(task.routeSource)! } : {}),
    ...(stringValue(task.resultPreview) ? { resultPreview: stringValue(task.resultPreview)! } : {}),
    ...(stringValue(task.error) ? { error: stringValue(task.error)! } : {}),
    startedAt,
    updatedAt: validTimestamp(task.updatedAt) ?? startedAt,
    ...(validTimestamp(task.finishedAt) ? { finishedAt: validTimestamp(task.finishedAt)! } : {})
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && values.includes(value) ? value as T[number] : undefined;
}

function newTaskId(): string {
  return `task-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}
