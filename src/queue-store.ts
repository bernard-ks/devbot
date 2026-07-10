import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  neutralizeMentions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  redactSensitiveText
} from "./security.js";

export type QueueMode = "answer" | "action";
export type QueueItemState = "queued" | "running" | "done" | "failed" | "skipped";

const QUEUE_ITEM_ID_PATTERN = /^queue-[a-z0-9-]{1,64}$/i;
const QUEUE_STATES: QueueItemState[] = ["queued", "running", "done", "failed", "skipped"];
const QUEUE_MODES: QueueMode[] = ["answer", "action"];

export interface QueueItem {
  id: string;
  project: string;
  taskText: string;
  mode: QueueMode;
  state: QueueItemState;
  addedBy: string;
  addedById: string;
  addedAt: string;
  taskId?: string;
  messageId?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  digestedAt?: string;
}

export interface QueueRunnerState {
  running: boolean;
  stopOnFailure: boolean;
  startedBy?: string;
  startedById?: string;
  startedAt?: string;
  /**
   * Project names the runner is authorized to process, captured from the controller who
   * started it. When present, only items on these projects are ever claimed, so starting or
   * stopping the queue can never trigger or halt work on a project the actor cannot control.
   * Undefined means an unscoped legacy runner (all projects) — only reachable for state written
   * before this field existed.
   */
  scopeProjects?: string[];
}

export interface ClaimNextOptions {
  /** Restrict claiming to items on these projects (the runner's control scope). */
  projects?: ReadonlySet<string>;
  /** When false, action-mode items are left queued (fail-closed while safe mode is on). */
  allowActionMode?: boolean;
}

export interface AddQueueItemInput {
  project: string;
  taskText: string;
  mode: QueueMode;
  addedBy: string;
  addedById: string;
}

interface QueueStateFile {
  version: 1;
  items: QueueItem[];
  runner: QueueRunnerState;
}

const DEFAULT_RUNNER_STATE: QueueRunnerState = {
  running: false,
  stopOnFailure: false
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
        taskText: sanitizeText(input.taskText),
        mode: input.mode,
        state: "queued",
        addedBy: input.addedBy,
        addedById: input.addedById,
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

  /**
   * Atomically claims the next runnable queued item by transitioning it to `running` before any
   * execution side effect starts. `options` narrows what counts as runnable: `projects` scopes
   * to the runner's authorized projects, and `allowActionMode: false` leaves action-mode items
   * queued (used to fail closed while safe mode is on). Items excluded by these filters stay
   * `queued` so they resume once the scope widens or safe mode is lifted.
   */
  async claimNext(options?: ClaimNextOptions): Promise<QueueItem | undefined> {
    return this.mutate((state) => {
      const item = nextRunnableItem(state.items, options);
      if (!item) {
        return undefined;
      }
      item.state = "running";
      item.startedAt = new Date().toISOString();
      return { ...item };
    });
  }

  async attachTaskId(id: string, taskId: string): Promise<void> {
    await this.mutateItem(id, (item) => {
      if (item.state !== "running") {
        throw new Error(`Queue item ${id} is not running; refusing to attach a task id.`);
      }
      item.taskId = taskId;
    });
  }

  async setMessageId(id: string, messageId: string): Promise<void> {
    await this.mutateItem(id, (item) => {
      item.messageId = messageId;
    });
  }

  async markFinished(id: string, result: { state: "done" | "failed"; summary: string }): Promise<void> {
    await this.mutateItem(id, (item) => {
      if (item.state !== "running") {
        throw new Error(`Queue item ${id} is not running; refusing to record a finished state.`);
      }
      item.state = result.state;
      item.summary = sanitizeText(result.summary);
      item.finishedAt = new Date().toISOString();
    });
  }

  async removeById(id: string): Promise<QueueItem | undefined> {
    return this.mutate((state) => {
      const item = state.items.find((entry) => entry.id === id);
      if (!item) {
        throw new Error(`No queue item found for \`${id}\`.`);
      }
      if (item.state === "running") {
        throw new Error("The currently running item cannot be removed. Use `/queue stop` first.");
      }
      if (item.state !== "queued") {
        throw new Error(`Queue item \`${id}\` already finished (${item.state}).`);
      }
      item.state = "skipped";
      item.finishedAt = new Date().toISOString();
      item.summary = "Removed before it started.";
      return { ...item };
    });
  }

  /** Only skips queued items whose project is in `allowedProjectNames`, so a controller can never clear work they cannot see. */
  async clear(allowedProjectNames: ReadonlySet<string>): Promise<number> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      let cleared = 0;
      for (const item of state.items) {
        if (item.state === "queued" && allowedProjectNames.has(item.project)) {
          item.state = "skipped";
          item.finishedAt = now;
          item.summary = "Removed by `/queue clear`.";
          cleared += 1;
        }
      }
      return cleared;
    });
  }

  async getRunner(): Promise<QueueRunnerState> {
    const state = await this.readState();
    return { ...state.runner };
  }

  async startRunner(
    startedBy: string,
    stopOnFailure: boolean,
    options?: { startedById?: string; scopeProjects?: readonly string[] }
  ): Promise<QueueRunnerState> {
    return this.mutate((state) => {
      state.runner.running = true;
      state.runner.stopOnFailure = stopOnFailure;
      state.runner.startedBy = startedBy;
      state.runner.startedAt = new Date().toISOString();
      if (options?.startedById) {
        state.runner.startedById = options.startedById;
      } else {
        delete state.runner.startedById;
      }
      if (options?.scopeProjects) {
        state.runner.scopeProjects = [...new Set(options.scopeProjects)];
      } else {
        delete state.runner.scopeProjects;
      }
      return { ...state.runner };
    });
  }

  async stopRunner(): Promise<QueueRunnerState> {
    return this.mutate((state) => {
      state.runner.running = false;
      return { ...state.runner };
    });
  }

  /** Items that finished a run but have not yet been included in a posted digest. */
  async listUndigested(): Promise<QueueItem[]> {
    const state = await this.readState();
    return state.items.filter((item) => (item.state === "done" || item.state === "failed") && !item.digestedAt).map((item) => ({ ...item }));
  }

  async markDigested(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const targets = new Set(ids);
    await this.mutate((state) => {
      const now = new Date().toISOString();
      for (const item of state.items) {
        if (targets.has(item.id)) {
          item.digestedAt = now;
        }
      }
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
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown;
      await hardenPrivateFilePermissions(this.stateFile);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Queue state must be a JSON object.");
      }
      const raw = parsed as { version?: unknown; items?: unknown; runner?: unknown };
      if (raw.version !== undefined && raw.version !== 1) {
        throw new Error(`Unsupported queue state version: ${String(raw.version)}.`);
      }
      this.state = {
        version: 1,
        items: Array.isArray(raw.items) ? raw.items.map(normalizeLoadedItem).filter((item): item is QueueItem => item !== undefined) : [],
        runner: normalizeLoadedRunner(raw.runner)
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

function sanitizeText(value: string): string {
  return neutralizeMentions(redactSensitiveText(value));
}

export function nextQueuedItem(items: QueueItem[]): QueueItem | undefined {
  return items.find((item) => item.state === "queued");
}

export function nextRunnableItem(items: QueueItem[], options?: ClaimNextOptions): QueueItem | undefined {
  return items.find((item) => {
    if (item.state !== "queued") {
      return false;
    }
    if (options?.projects && !options.projects.has(item.project)) {
      return false;
    }
    if (options?.allowActionMode === false && item.mode === "action") {
      return false;
    }
    return true;
  });
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

export function groupQueueItemsByProject(items: QueueItem[]): Map<string, QueueItem[]> {
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) {
    const group = groups.get(item.project);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.project, [item]);
    }
  }
  return groups;
}

export function formatQueueList(items: QueueItem[]): string {
  if (items.length === 0) {
    return "The queue is empty. Use `/queue add` to stack a task.";
  }

  return items
    .map((item, index) => {
      const summary = item.summary ? `: ${truncate(item.summary, 90)}` : "";
      return `${index + 1}. **${item.state}** ${item.mode} on \`${item.project}\` by ${item.addedBy} (\`${item.id}\`)${summary}\n   ${truncate(item.taskText, 120)}`;
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
  return QUEUE_ITEM_ID_PATTERN.test(value);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function normalizeLoadedItem(value: unknown): QueueItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<QueueItem>;
  if (
    typeof item.id !== "string" ||
    !isQueueItemId(item.id) ||
    typeof item.project !== "string" ||
    typeof item.taskText !== "string" ||
    !QUEUE_MODES.includes(item.mode as QueueMode) ||
    !QUEUE_STATES.includes(item.state as QueueItemState) ||
    typeof item.addedBy !== "string" ||
    typeof item.addedAt !== "string" ||
    !Number.isFinite(Date.parse(item.addedAt))
  ) {
    return undefined;
  }
  return {
    id: item.id,
    project: item.project,
    taskText: sanitizeText(item.taskText),
    mode: item.mode as QueueMode,
    state: item.state as QueueItemState,
    addedBy: item.addedBy,
    addedById: stringValue(item.addedById) ?? "unknown",
    addedAt: item.addedAt,
    ...(stringValue(item.taskId) ? { taskId: stringValue(item.taskId)! } : {}),
    ...(stringValue(item.messageId) ? { messageId: stringValue(item.messageId)! } : {}),
    ...(validTimestamp(item.startedAt) ? { startedAt: validTimestamp(item.startedAt)! } : {}),
    ...(validTimestamp(item.finishedAt) ? { finishedAt: validTimestamp(item.finishedAt)! } : {}),
    ...(stringValue(item.summary) ? { summary: sanitizeText(stringValue(item.summary)!) } : {}),
    ...(validTimestamp(item.digestedAt) ? { digestedAt: validTimestamp(item.digestedAt)! } : {})
  };
}

function normalizeLoadedRunner(value: unknown): QueueRunnerState {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_RUNNER_STATE };
  }
  const runner = value as Partial<QueueRunnerState>;
  const scopeProjects = Array.isArray(runner.scopeProjects)
    ? [...new Set(runner.scopeProjects.filter((name): name is string => typeof name === "string" && name.length > 0))]
    : undefined;
  return {
    running: runner.running === true,
    stopOnFailure: runner.stopOnFailure === true,
    ...(stringValue(runner.startedBy) ? { startedBy: stringValue(runner.startedBy)! } : {}),
    ...(stringValue(runner.startedById) ? { startedById: stringValue(runner.startedById)! } : {}),
    ...(validTimestamp(runner.startedAt) ? { startedAt: validTimestamp(runner.startedAt)! } : {}),
    ...(scopeProjects ? { scopeProjects } : {})
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
