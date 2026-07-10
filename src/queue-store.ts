import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type QueueMode = "answer" | "action";
export type QueueItemState = "queued" | "running" | "done" | "failed" | "skipped";

export interface QueueItem {
  id: string;
  project: string;
  taskText: string;
  mode: QueueMode;
  state: QueueItemState;
  addedBy: string;
  addedAt: string;
  taskId?: string;
  messageId?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
}

export interface QueueRunnerState {
  running: boolean;
  stopOnFailure: boolean;
  startedBy?: string;
  startedAt?: string;
  pendingDigest: boolean;
}

export interface AddQueueItemInput {
  project: string;
  taskText: string;
  mode: QueueMode;
  addedBy: string;
}

interface QueueStateFile {
  version: 1;
  items: QueueItem[];
  runner: QueueRunnerState;
}

const DEFAULT_RUNNER_STATE: QueueRunnerState = {
  running: false,
  stopOnFailure: false,
  pendingDigest: false
};

export class QueueStore {
  private state: QueueStateFile | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile = path.resolve(".devbot", "queue.json"),
    private readonly maxRecords = 300
  ) {}

  async add(input: AddQueueItemInput): Promise<QueueItem> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const item: QueueItem = {
        id: newQueueItemId(),
        project: input.project,
        taskText: input.taskText,
        mode: input.mode,
        state: "queued",
        addedBy: input.addedBy,
        addedAt: now
      };
      state.items.push(item);
      state.items = retainQueueItems(state.items, this.maxRecords);
      return { ...item };
    });
  }

  async list(): Promise<QueueItem[]> {
    const state = await this.readState();
    return state.items.map((item) => ({ ...item }));
  }

  async get(id: string): Promise<QueueItem | undefined> {
    const state = await this.readState();
    const item = state.items.find((entry) => entry.id === id);
    return item ? { ...item } : undefined;
  }

  async removeAtPosition(position: number): Promise<QueueItem | undefined> {
    return this.mutate((state) => {
      const item = state.items[position - 1];
      if (!item) {
        throw new Error(`No queue item at position ${position}.`);
      }
      if (item.state === "running") {
        throw new Error("The currently running item cannot be removed. Use `/queue stop` first.");
      }
      if (item.state !== "queued") {
        throw new Error(`Queue item at position ${position} already finished (${item.state}).`);
      }
      item.state = "skipped";
      item.finishedAt = new Date().toISOString();
      item.summary = "Removed before it started.";
      return { ...item };
    });
  }

  async clear(): Promise<number> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      let cleared = 0;
      for (const item of state.items) {
        if (item.state === "queued") {
          item.state = "skipped";
          item.finishedAt = now;
          item.summary = "Removed by `/queue clear`.";
          cleared += 1;
        }
      }
      return cleared;
    });
  }

  async nextQueued(): Promise<QueueItem | undefined> {
    const state = await this.readState();
    const item = nextQueuedItem(state.items);
    return item ? { ...item } : undefined;
  }

  async markRunning(id: string, taskId: string): Promise<void> {
    await this.mutateItem(id, (item) => {
      item.state = "running";
      item.taskId = taskId;
      item.startedAt = new Date().toISOString();
    });
  }

  async setMessageId(id: string, messageId: string): Promise<void> {
    await this.mutateItem(id, (item) => {
      item.messageId = messageId;
    });
  }

  async markFinished(id: string, result: { state: "done" | "failed"; summary: string }): Promise<void> {
    await this.mutateItem(id, (item) => {
      item.state = result.state;
      item.summary = result.summary;
      item.finishedAt = new Date().toISOString();
    });
  }

  async getRunner(): Promise<QueueRunnerState> {
    const state = await this.readState();
    return { ...state.runner };
  }

  async startRunner(startedBy: string, stopOnFailure: boolean): Promise<QueueRunnerState> {
    return this.mutate((state) => {
      state.runner.running = true;
      state.runner.stopOnFailure = stopOnFailure;
      state.runner.startedBy = startedBy;
      state.runner.startedAt = new Date().toISOString();
      return { ...state.runner };
    });
  }

  async stopRunner(): Promise<QueueRunnerState> {
    return this.mutate((state) => {
      state.runner.running = false;
      return { ...state.runner };
    });
  }

  async setPendingDigest(pending: boolean): Promise<void> {
    await this.mutate((state) => {
      state.runner.pendingDigest = pending;
    });
  }

  async recoverInterrupted(reason: string): Promise<QueueItem[]> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const recovered: QueueItem[] = [];
      for (const item of state.items) {
        if (item.state !== "running") {
          continue;
        }
        item.state = "failed";
        item.summary = reason;
        item.finishedAt = now;
        recovered.push({ ...item });
      }
      return recovered;
    });
  }

  private async mutateItem(id: string, apply: (item: QueueItem) => void): Promise<void> {
    await this.mutate((state) => {
      const item = state.items.find((entry) => entry.id === id);
      if (!item) {
        throw new Error(`No queue item found for ${id}.`);
      }
      apply(item);
    });
  }

  private async readState(): Promise<QueueStateFile> {
    await this.mutationTail;
    return this.load();
  }

  private async mutate<T>(mutation: (state: QueueStateFile) => T): Promise<T> {
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

  private async load(): Promise<QueueStateFile> {
    if (this.state) {
      return this.state;
    }

    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as QueueStateFile;
      this.state = {
        version: 1,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        runner: { ...DEFAULT_RUNNER_STATE, ...(parsed.runner ?? {}) }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read queue state at ${this.stateFile}: ${(error as Error).message}`, { cause: error });
      }
      this.state = { version: 1, items: [], runner: { ...DEFAULT_RUNNER_STATE } };
    }

    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) {
      return;
    }

    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(tempFile, this.stateFile);
  }
}

export function nextQueuedItem(items: QueueItem[]): QueueItem | undefined {
  return items.find((item) => item.state === "queued");
}

export function pendingQueueCount(items: QueueItem[]): number {
  return items.filter((item) => item.state === "queued" || item.state === "running").length;
}

export function retainQueueItems(items: QueueItem[], maxRecords: number): QueueItem[] {
  const activeCount = items.filter((item) => item.state === "queued" || item.state === "running").length;
  let finishedBudget = Math.max(0, maxRecords - activeCount);
  const keep: QueueItem[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    if (item.state === "queued" || item.state === "running") {
      keep.push(item);
      continue;
    }
    if (finishedBudget <= 0) {
      continue;
    }
    finishedBudget -= 1;
    keep.push(item);
  }
  return keep.reverse();
}

export function formatQueueList(items: QueueItem[]): string {
  if (items.length === 0) {
    return "The queue is empty. Use `/queue add` to stack a task.";
  }

  return items
    .map((item, index) => {
      const summary = item.summary ? `: ${truncate(item.summary, 90)}` : "";
      return `${index + 1}. **${item.state}** ${item.mode} on \`${item.project}\` by ${item.addedBy}${summary}\n   ${truncate(item.taskText, 120)}`;
    })
    .join("\n");
}

export interface QueueDigestOptions {
  guildId: string;
  channelId: string;
}

export function formatQueueDigest(items: QueueItem[], options: QueueDigestOptions): string {
  const relevant = items.filter((item) => item.state !== "skipped");
  if (relevant.length === 0) {
    return "Morning digest: the queue drained with nothing to report.";
  }

  const done = relevant.filter((item) => item.state === "done").length;
  const failed = relevant.filter((item) => item.state === "failed").length;
  const awaitingReview = relevant.filter((item) => item.state === "done" && item.mode === "action");

  const lines = relevant.map((item) => {
    const link = item.messageId ? ` (${messageLink(options, item.messageId)})` : "";
    const summary = item.summary ? truncate(item.summary, 160) : "No summary recorded.";
    return `- **${item.state}** ${item.mode} on \`${item.project}\`${link}: ${summary}`;
  });

  return [
    "Morning digest — the overnight queue drained.",
    `Totals: ${done} done, ${failed} failed, ${relevant.length} total.`,
    "",
    ...lines,
    "",
    awaitingReview.length > 0
      ? `Awaiting review: ${awaitingReview.length} completed change${awaitingReview.length === 1 ? "" : "s"}.`
      : "Nothing is awaiting review."
  ].join("\n");
}

function messageLink(options: QueueDigestOptions, messageId: string): string {
  return `https://discord.com/channels/${options.guildId}/${options.channelId}/${messageId}`;
}

function newQueueItemId(): string {
  return `queue-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function isQueueItemId(value: string): boolean {
  return /^queue-[a-z0-9-]{1,64}$/i.test(value);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}
