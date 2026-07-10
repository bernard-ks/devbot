import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { selectRelevantMemories } from "./memory-recall.js";
import type { ProjectEntry } from "./types.js";

export type MemoryKind = "decision" | "outcome" | "note";
export type MemorySource = "task" | "manual";

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  taskId?: string;
  author: string;
  createdAt: string;
  tags: string[];
}

export interface AddMemoryInput {
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  taskId?: string;
  author: string;
  tags?: string[];
}

export interface ListMemoryOptions {
  kind?: MemoryKind;
  limit?: number;
}

const DEFAULT_MAX_OUTCOMES = 500;

export class MemoryStore {
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(private readonly maxOutcomes = DEFAULT_MAX_OUTCOMES) {}

  fileFor(project: Pick<ProjectEntry, "root">): string {
    return path.join(project.root, ".devbot", "memory.jsonl");
  }

  async add(project: Pick<ProjectEntry, "root">, input: AddMemoryInput): Promise<MemoryEntry> {
    const text = input.text.trim();
    if (!text) {
      throw new Error("Memory text cannot be empty.");
    }

    const entry: MemoryEntry = {
      id: newMemoryId(),
      kind: input.kind,
      text,
      source: input.source,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      author: input.author,
      createdAt: new Date().toISOString(),
      tags: dedupeTags(input.tags ?? [])
    };

    await this.mutate(project, (entries) => {
      entries.push(entry);
      return pruneOutcomes(entries, this.maxOutcomes);
    });

    return entry;
  }

  async list(project: Pick<ProjectEntry, "root">, options: ListMemoryOptions = {}): Promise<MemoryEntry[]> {
    const entries = await this.readAll(project);
    const filtered = options.kind ? entries.filter((entry) => entry.kind === options.kind) : entries;
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    return [...filtered].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
  }

  async search(project: Pick<ProjectEntry, "root">, query: string, limit = 10): Promise<MemoryEntry[]> {
    const entries = await this.readAll(project);
    return selectRelevantMemories(entries, query, limit);
  }

  async recallFor(project: Pick<ProjectEntry, "root">, requestText: string): Promise<MemoryEntry[]> {
    const entries = await this.readAll(project);
    return selectRelevantMemories(entries, requestText);
  }

  async forget(project: Pick<ProjectEntry, "root">, id: string): Promise<boolean> {
    let removed = false;
    await this.mutate(project, (entries) =>
      entries.filter((entry) => {
        if (entry.id === id) {
          removed = true;
          return false;
        }
        return true;
      })
    );
    return removed;
  }

  async count(project: Pick<ProjectEntry, "root">): Promise<number> {
    return (await this.readAll(project)).length;
  }

  private async readAll(project: Pick<ProjectEntry, "root">): Promise<MemoryEntry[]> {
    const file = this.fileFor(project);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new Error(`Unable to read memory store at ${file}: ${(error as Error).message}`, { cause: error });
    }
    return parseJsonl(raw);
  }

  private async mutate(
    project: Pick<ProjectEntry, "root">,
    mutation: (entries: MemoryEntry[]) => MemoryEntry[]
  ): Promise<void> {
    const file = this.fileFor(project);
    const previousTail = this.mutationTails.get(file) ?? Promise.resolve();
    const operation = previousTail.then(async () => {
      const entries = await this.readAll(project);
      const next = mutation(entries);
      await writeAll(file, next);
    });
    this.mutationTails.set(
      file,
      operation.catch(() => undefined)
    );
    await operation;
  }
}

export async function checkMemoryStoreHealth(project: Pick<ProjectEntry, "root">): Promise<{ readable: boolean; writable: boolean }> {
  const file = path.join(project.root, ".devbot", "memory.jsonl");
  let readable = true;
  try {
    await readFile(file, "utf8");
  } catch (error) {
    readable = (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  let writable = true;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const probe = `${file}.healthcheck-${process.pid}.tmp`;
    await writeFile(probe, "");
    await rm(probe, { force: true });
  } catch {
    writable = false;
  }

  return { readable, writable };
}

export function formatMemoryList(entries: MemoryEntry[], projectName: string, query?: string): string {
  if (entries.length === 0) {
    return query
      ? `No memory entries for \`${projectName}\` match "${query}".`
      : `No memory entries recorded yet for \`${projectName}\`.`;
  }

  const header = query ? `Memory matches for \`${projectName}\` on "${query}":` : `Memory for \`${projectName}\`:`;
  return [header, ...entries.map(formatMemoryLine)].join("\n");
}

function formatMemoryLine(entry: MemoryEntry): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
  const task = entry.taskId ? ` (task \`${entry.taskId}\`)` : "";
  return `- \`${entry.id}\` [${formatTime(entry.createdAt)}] ${entry.kind}/${entry.source}: ${truncate(entry.text, 200)}${task}${tags}`;
}

function pruneOutcomes(entries: MemoryEntry[], maxOutcomes: number): MemoryEntry[] {
  const outcomes = entries
    .filter((entry) => entry.kind === "outcome")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (outcomes.length <= maxOutcomes) {
    return entries;
  }

  const keepIds = new Set(outcomes.slice(0, maxOutcomes).map((entry) => entry.id));
  return entries.filter((entry) => entry.kind !== "outcome" || keepIds.has(entry.id));
}

async function writeAll(file: string, entries: MemoryEntry[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(tempFile, entries.length > 0 ? `${body}\n` : "");
  await rename(tempFile, file);
}

function parseJsonl(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed) as MemoryEntry);
    } catch {
      // Skip a corrupted line rather than losing the rest of the store.
    }
  }
  return entries;
}

function newMemoryId(): string {
  return `mem-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
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
