import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type TaskStatus = "running" | "succeeded" | "failed" | "canceled";

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  source: string;
  mode: string;
  projectName: string;
  requester: string;
  text: string;
  includePatterns: string[];
  contextFileCount?: number;
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
}

interface TaskStateFile {
  version: 1;
  tasks: TaskRecord[];
}

export class TaskStore {
  private state: TaskStateFile | undefined;

  constructor(
    private readonly stateFile = path.resolve(".devbot", "tasks.json"),
    private readonly maxRecords = 500
  ) {}

  async start(input: StartTaskInput): Promise<TaskRecord> {
    const state = await this.load();
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: newTaskId(),
      status: "running",
      source: input.source,
      mode: input.mode,
      projectName: input.projectName,
      requester: input.requester,
      text: input.text,
      includePatterns: input.includePatterns ?? [],
      startedAt: now,
      updatedAt: now
    };

    state.tasks.unshift(task);
    state.tasks = state.tasks.slice(0, this.maxRecords);
    await this.save();
    return task;
  }

  async succeed(id: string, result: { contextFileCount?: number; resultPreview?: string }): Promise<void> {
    await this.update(id, (task, now) => {
      task.status = "succeeded";
      if (result.contextFileCount !== undefined) {
        task.contextFileCount = result.contextFileCount;
      }
      if (result.resultPreview !== undefined) {
        task.resultPreview = result.resultPreview;
      }
      task.finishedAt = now;
    });
  }

  async fail(id: string, error: unknown): Promise<void> {
    await this.update(id, (task, now) => {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.finishedAt = now;
    });
  }

  async cancel(id: string, reason = "Canceled by user request."): Promise<TaskRecord | undefined> {
    let canceled: TaskRecord | undefined;
    await this.update(id, (task, now) => {
      if (task.status !== "running") {
        canceled = task;
        return;
      }

      task.status = "canceled";
      task.error = reason;
      task.finishedAt = now;
      canceled = task;
    });
    return canceled;
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    const state = await this.load();
    return state.tasks.find((task) => task.id === id);
  }

  async listRecent(options: { limit?: number; projectName?: string; status?: TaskStatus } = {}): Promise<TaskRecord[]> {
    const state = await this.load();
    const limit = Math.max(1, Math.min(options.limit ?? 10, 25));
    return state.tasks
      .filter((task) => !options.projectName || task.projectName === options.projectName)
      .filter((task) => !options.status || task.status === options.status)
      .slice(0, limit);
  }

  private async update(id: string, apply: (task: TaskRecord, now: string) => void): Promise<void> {
    const state = await this.load();
    const task = state.tasks.find((item) => item.id === id);
    if (!task) {
      return;
    }

    const now = new Date().toISOString();
    apply(task, now);
    task.updatedAt = now;
    await this.save();
  }

  private async load(): Promise<TaskStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as TaskStateFile;
      this.state = { version: 1, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
    } catch {
      this.state = { version: 1, tasks: [] };
    }

    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) {
      return;
    }

    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(tempFile, this.stateFile);
  }
}

export function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "No saved tasks found.";
  }

  return tasks
    .map((task) => {
      const finished = task.finishedAt ? `, finished ${formatTime(task.finishedAt)}` : "";
      return `- \`${task.id}\` ${task.status} ${task.mode} via ${task.source} on \`${task.projectName}\` for ${task.requester}${finished}: ${truncate(task.text, 90)}`;
    })
    .join("\n");
}

export function formatTaskLogs(task: TaskRecord): string {
  return [
    `Task \`${task.id}\` logs`,
    `Status: ${task.status}`,
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
    `Requester: ${task.requester}`,
    `Started: ${formatTime(task.startedAt)}`,
    task.finishedAt ? `Finished: ${formatTime(task.finishedAt)}` : undefined,
    task.contextFileCount !== undefined ? `Context files: ${task.contextFileCount}` : undefined,
    task.includePatterns.length > 0 ? `Include: \`${task.includePatterns.join(", ")}\`` : undefined,
    "",
    "Request:",
    truncate(task.text, 800),
    task.resultPreview ? ["", "Result preview:", truncate(task.resultPreview, 1_200)].join("\n") : undefined,
    task.error ? ["", "Error:", truncate(task.error, 1_200)].join("\n") : undefined
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function newTaskId(): string {
  return `task-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
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
