import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canAccessScopedRecord, type TaskAccessContext } from "./task-access.js";
import { selectRelevantMemories } from "./memory-recall.js";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  redactSensitiveText
} from "./security.js";
import type { ProjectEntry } from "./types.js";

export type MemoryKind = "decision" | "outcome" | "note";
export type MemorySource = "task" | "manual";
export type MemoryAccessScope = "project" | "workroom";
export type MemoryStatus = "active" | "proposed" | "superseded";
export type MemoryTrust = "trusted" | "untrusted";
export type MemoryAccessContext = TaskAccessContext;

export const MEMORY_SCHEMA_VERSION = 1;

export interface MemoryEntry {
  schemaVersion: 1;
  id: string;
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  taskId?: string;
  branch?: string;
  author: string;
  actorId?: string;
  createdAt: string;
  tags: string[];
  accessScope: MemoryAccessScope;
  requesterId?: string;
  internal?: boolean;
  status: MemoryStatus;
  trust: MemoryTrust;
}

export interface AddMemoryInput {
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  taskId?: string;
  branch?: string;
  author: string;
  actorId?: string;
  tags?: string[];
  accessScope?: MemoryAccessScope;
  requesterId?: string;
  internal?: boolean;
  status?: MemoryStatus;
  trust?: MemoryTrust;
}

export interface ListMemoryOptions {
  access: MemoryAccessContext;
  kind?: MemoryKind;
  limit?: number;
}

interface MemoryFileState {
  entries: MemoryEntry[];
  quarantined: string[];
}

export const DEFAULT_MEMORY_STORE_ROOT = path.resolve(".devbot", "memory");
const DEFAULT_MAX_OUTCOMES = 500;
export const MAX_ENTRY_TEXT_CHARS = 4_000;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_AUTHOR_LENGTH = 120;
export const MAX_ID_FIELD_LENGTH = 80;
export const MAX_TOTAL_ENTRIES = 2_000;
export const MAX_FILE_BYTES = 4_000_000;

export class MemoryStore {
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly legacyMigrations = new Map<string, Promise<void>>();
  readonly root: string;

  constructor(
    storeRoot: string = DEFAULT_MEMORY_STORE_ROOT,
    private readonly maxOutcomes = DEFAULT_MAX_OUTCOMES,
    private readonly maxTotalEntries = MAX_TOTAL_ENTRIES,
    private readonly maxFileBytes = MAX_FILE_BYTES
  ) {
    this.root = path.resolve(storeRoot);
  }

  async fileFor(project: Pick<ProjectEntry, "root">): Promise<string> {
    const key = await canonicalProjectKey(project);
    const file = path.join(this.root, `${key}.jsonl`);
    assertWithinStoreRoot(this.root, file);
    return file;
  }

  async add(project: Pick<ProjectEntry, "root">, input: AddMemoryInput): Promise<MemoryEntry> {
    const entry = buildEntry(input);

    await this.mutate(project, (state) => {
      const nextEntries = pruneEntries([...state.entries, entry], this.maxOutcomes, this.maxTotalEntries);
      assertFileBudget(nextEntries, state.quarantined, this.maxFileBytes);
      return { entries: nextEntries, quarantined: state.quarantined };
    });

    return entry;
  }

  async list(project: Pick<ProjectEntry, "root">, options: ListMemoryOptions): Promise<MemoryEntry[]> {
    const entries = (await this.readAll(project)).filter((entry) => canAccessScopedRecord(entry, options.access));
    const filtered = options.kind ? entries.filter((entry) => entry.kind === options.kind) : entries;
    const limit = clampLimit(options.limit);
    return [...filtered].sort(byRecencyDesc).slice(0, limit);
  }

  /** Looks up a single entry by ID, honoring the same access rule as list/search/recall. */
  async get(project: Pick<ProjectEntry, "root">, id: string, access: MemoryAccessContext): Promise<MemoryEntry | undefined> {
    const entries = await this.readAll(project);
    const entry = entries.find((item) => item.id === id);
    return entry && canAccessScopedRecord(entry, access) ? entry : undefined;
  }

  async search(project: Pick<ProjectEntry, "root">, query: string, access: MemoryAccessContext, limit = 10): Promise<MemoryEntry[]> {
    const entries = (await this.readAll(project)).filter((entry) => canAccessScopedRecord(entry, access));
    return selectRelevantMemories(entries, query, limit);
  }

  /** Entries eligible to be recalled verbatim into a model prompt: access-checked, active, and controller-authored/promoted. */
  async recallFor(project: Pick<ProjectEntry, "root">, requestText: string, access: MemoryAccessContext): Promise<MemoryEntry[]> {
    const entries = (await this.readAll(project)).filter(
      (entry) => canAccessScopedRecord(entry, access) && entry.status === "active" && entry.trust === "trusted"
    );
    return selectRelevantMemories(entries, requestText);
  }

  async forget(project: Pick<ProjectEntry, "root">, id: string): Promise<boolean> {
    let removed = false;
    await this.mutate(project, (state) => ({
      entries: state.entries.filter((entry) => {
        if (entry.id === id) {
          removed = true;
          return false;
        }
        return true;
      }),
      quarantined: state.quarantined
    }));
    return removed;
  }

  /** Marks an automatically captured outcome as human-approved so it becomes eligible for prompt recall. */
  async promote(project: Pick<ProjectEntry, "root">, id: string): Promise<MemoryEntry | undefined> {
    let promoted: MemoryEntry | undefined;
    await this.mutate(project, (state) => ({
      entries: state.entries.map((entry) => {
        if (entry.id !== id) return entry;
        promoted = { ...entry, status: "active", trust: "trusted" };
        return promoted;
      }),
      quarantined: state.quarantined
    }));
    return promoted;
  }

  async count(project: Pick<ProjectEntry, "root">): Promise<number> {
    return (await this.readAll(project)).length;
  }

  /** Deletes the project's entire memory file. Used when a repository is removed from setup. */
  async purgeProject(project: Pick<ProjectEntry, "root">): Promise<void> {
    const file = await this.fileFor(project);
    await rm(file, { force: true });
  }

  private async readAll(project: Pick<ProjectEntry, "root">): Promise<MemoryEntry[]> {
    return (await this.readState(project)).entries;
  }

  private async readState(project: Pick<ProjectEntry, "root">): Promise<MemoryFileState> {
    const file = await this.fileFor(project);
    await this.ensureLegacyMigrated(project, file);
    return this.readStateFromFile(file);
  }

  private async readStateFromFile(file: string): Promise<MemoryFileState> {
    let raw: string;
    try {
      raw = await readFileRejectingSymlinks(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { entries: [], quarantined: [] };
      }
      if (code === "ELOOP") {
        throw new Error(`Refusing to read memory store through a symlink: ${file}`, { cause: error });
      }
      throw new Error(`Unable to read memory store at ${file}: ${(error as Error).message}`, { cause: error });
    }
    await hardenPrivateFilePermissions(file);
    return parseJsonl(raw);
  }

  private async ensureLegacyMigrated(project: Pick<ProjectEntry, "root">, file: string): Promise<void> {
    let migration = this.legacyMigrations.get(file);
    if (!migration) {
      migration = this.migrateLegacyProjectMemory(project, file).catch((error: unknown) => {
        console.warn(`Skipping legacy project memory migration for ${project.root}: ${(error as Error).message}`);
      });
      this.legacyMigrations.set(file, migration);
    }
    await migration;
  }

  /**
   * Reads a memory file that an earlier Devbot build wrote inside the managed
   * project checkout, merges its records into the central store (invalid lines
   * are quarantined, migrated entries keep their normalized untrusted-by-default
   * state so they are never auto-recalled without promotion), then retires the
   * stray file so it can never be committed to the target repository or read
   * from the project root. Symlinked or oversized legacy files are left alone.
   */
  private async migrateLegacyProjectMemory(project: Pick<ProjectEntry, "root">, centralFile: string): Promise<void> {
    const legacyDirectory = path.join(project.root, ".devbot");
    const legacyFile = path.join(legacyDirectory, "memory.jsonl");
    const directoryStats = await lstat(legacyDirectory).catch(() => undefined);
    if (!directoryStats || directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      return;
    }
    const fileStats = await lstat(legacyFile).catch(() => undefined);
    if (!fileStats || !fileStats.isFile()) {
      return;
    }
    if (fileStats.size > this.maxFileBytes) {
      throw new Error(`legacy memory file exceeds the ${this.maxFileBytes}-byte budget; leaving it in place`);
    }

    const legacy = parseJsonl(await readFileRejectingSymlinks(legacyFile));
    const current = await this.readStateFromFile(centralFile);
    const knownIds = new Set(current.entries.map((entry) => entry.id));
    const merged: MemoryFileState = {
      entries: [...current.entries, ...legacy.entries.filter((entry) => !knownIds.has(entry.id))],
      quarantined: [...current.quarantined, ...legacy.quarantined]
    };
    await writeAll(centralFile, merged, this.maxFileBytes);
    await rm(legacyFile, { force: true });
    await rmdir(legacyDirectory).catch(() => undefined);
  }

  private async mutate(
    project: Pick<ProjectEntry, "root">,
    mutation: (state: MemoryFileState) => MemoryFileState
  ): Promise<void> {
    const file = await this.fileFor(project);
    const previousTail = this.mutationTails.get(file) ?? Promise.resolve();
    const operation = previousTail.then(async () => {
      const state = await this.readState(project);
      const next = mutation(state);
      await writeAll(file, next, this.maxFileBytes);
    });
    this.mutationTails.set(
      file,
      operation.catch(() => undefined)
    );
    await operation;
  }
}

export interface MemoryStoreHealth {
  readable: boolean;
  writable: boolean;
  quarantinedCount: number;
}

export async function checkMemoryStoreHealth(
  project: Pick<ProjectEntry, "root">,
  storeRoot: string = DEFAULT_MEMORY_STORE_ROOT
): Promise<MemoryStoreHealth> {
  const key = await canonicalProjectKey(project);
  const file = path.join(path.resolve(storeRoot), `${key}.jsonl`);
  let readable = true;
  let quarantinedCount = 0;
  try {
    const raw = await readFileRejectingSymlinks(file);
    quarantinedCount = parseJsonl(raw).quarantined.length;
  } catch (error) {
    readable = (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  let writable = true;
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await hardenPrivateDirectoryPermissions(path.dirname(file));
    const probe = `${file}.healthcheck-${process.pid}.tmp`;
    await writeFile(probe, "", { mode: PRIVATE_FILE_MODE, flag: "wx" });
    await rm(probe, { force: true });
  } catch {
    writable = false;
  }

  return { readable, writable, quarantinedCount };
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
  const state = entry.status === "active" ? "" : ` {${entry.status}}`;
  return `- \`${entry.id}\` [${formatTime(entry.createdAt)}] ${entry.kind}/${entry.source}: ${truncate(redactSensitiveText(entry.text), 200)}${task}${tags}${state}`;
}

function buildEntry(input: AddMemoryInput): MemoryEntry {
  const text = redactSensitiveText(input.text.trim());
  if (!text) {
    throw new Error("Memory text cannot be empty.");
  }
  if (text.length > MAX_ENTRY_TEXT_CHARS) {
    throw new Error(`Memory text exceeds the ${MAX_ENTRY_TEXT_CHARS}-character limit.`);
  }

  const author = redactSensitiveText(input.author.trim()).slice(0, MAX_AUTHOR_LENGTH) || "unknown";
  const tags = dedupeTags(input.tags ?? []);
  const source = input.source;
  const status = input.status ?? (source === "manual" ? "active" : "proposed");
  const trust = input.trust ?? (source === "manual" ? "trusted" : "untrusted");

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: newMemoryId(),
    kind: input.kind,
    text,
    source,
    ...(input.taskId ? { taskId: boundedField(input.taskId) } : {}),
    ...(input.branch ? { branch: boundedField(input.branch) } : {}),
    author,
    ...(input.actorId ? { actorId: boundedField(input.actorId) } : {}),
    createdAt: new Date().toISOString(),
    tags,
    accessScope: input.accessScope ?? "project",
    ...(input.requesterId ? { requesterId: boundedField(input.requesterId) } : {}),
    ...(input.internal ? { internal: true } : {}),
    status,
    trust
  };
}

function boundedField(value: string): string {
  return redactSensitiveText(value.trim()).slice(0, MAX_ID_FIELD_LENGTH);
}

function pruneEntries(entries: MemoryEntry[], maxOutcomes: number, maxTotalEntries: number): MemoryEntry[] {
  const withoutOverflowOutcomes = pruneOutcomes(entries, maxOutcomes);
  return pruneToTotalCap(withoutOverflowOutcomes, maxTotalEntries);
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

/** Bounds total entry count, dropping the oldest low-trust/proposed entries first, then the oldest overall. */
function pruneToTotalCap(entries: MemoryEntry[], maxTotal: number): MemoryEntry[] {
  if (entries.length <= maxTotal) {
    return entries;
  }

  const ranked = [...entries].sort((a, b) => {
    const priority = retentionPriority(a) - retentionPriority(b);
    if (priority !== 0) return priority;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
  const dropIds = new Set(ranked.slice(0, entries.length - maxTotal).map((entry) => entry.id));
  return entries.filter((entry) => !dropIds.has(entry.id));
}

function retentionPriority(entry: MemoryEntry): number {
  if (entry.status === "superseded") return 0;
  if (entry.status === "proposed") return 1;
  if (entry.trust === "untrusted") return 2;
  return 3;
}

function assertFileBudget(entries: MemoryEntry[], quarantined: string[], maxFileBytes: number): void {
  const bytes = Buffer.byteLength(serializeState(entries, quarantined), "utf8");
  if (bytes > maxFileBytes) {
    throw new Error(`Project memory store would exceed its ${maxFileBytes}-byte limit. Forget older entries before recording more.`);
  }
}

function serializeState(entries: MemoryEntry[], quarantined: string[]): string {
  const lines = [...entries.map((entry) => JSON.stringify(entry)), ...quarantined];
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

async function writeAll(file: string, state: MemoryFileState, maxFileBytes: number): Promise<void> {
  assertFileBudget(state.entries, state.quarantined, maxFileBytes);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await hardenPrivateDirectoryPermissions(directory);
  await rejectSymlinkAtPath(file);
  const tempFile = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tempFile, serializeState(state.entries, state.quarantined), {
    encoding: "utf8",
    flag: "wx",
    mode: PRIVATE_FILE_MODE
  });
  await rename(tempFile, file);
  await hardenPrivateFilePermissions(file);
}

async function rejectSymlinkAtPath(file: string): Promise<void> {
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to write memory store through a symlink: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readFileRejectingSymlinks(file: string): Promise<string> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertWithinStoreRoot(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Refusing to use a memory store path outside its managed root: ${file}`);
  }
}

async function canonicalProjectKey(project: Pick<ProjectEntry, "root">): Promise<string> {
  const resolved = await realpath(project.root).catch(() => path.resolve(project.root));
  return createHash("sha256").update(resolved).digest("hex").slice(0, 40);
}

/** Parses the JSONL memory file into valid entries plus quarantined raw lines that failed schema validation. */
function parseJsonl(raw: string): MemoryFileState {
  const entries: MemoryEntry[] = [];
  const quarantined: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      quarantined.push(trimmed);
      continue;
    }

    const entry = normalizeStoredEntry(parsed);
    if (entry) {
      entries.push(entry);
    } else {
      quarantined.push(trimmed);
    }
  }
  return { entries, quarantined };
}

/** Strictly validates and normalizes a raw parsed JSON value into a MemoryEntry, or returns undefined to quarantine it. */
function normalizeStoredEntry(value: unknown): MemoryEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<MemoryEntry> & Record<string, unknown>;

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return undefined;
  }
  if (typeof raw.id !== "string" || !/^mem-[a-z0-9-]{1,60}$/i.test(raw.id)) return undefined;

  const kinds: MemoryKind[] = ["decision", "outcome", "note"];
  if (typeof raw.kind !== "string" || !kinds.includes(raw.kind as MemoryKind)) return undefined;

  const sources: MemorySource[] = ["task", "manual"];
  if (typeof raw.source !== "string" || !sources.includes(raw.source as MemorySource)) return undefined;

  if (typeof raw.text !== "string" || !raw.text.trim()) return undefined;
  const text = redactSensitiveText(raw.text).slice(0, MAX_ENTRY_TEXT_CHARS);

  if (typeof raw.author !== "string") return undefined;
  const author = redactSensitiveText(raw.author).slice(0, MAX_AUTHOR_LENGTH) || "unknown";

  const createdAt = typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString();
  const tags = Array.isArray(raw.tags) ? dedupeTags(raw.tags.filter((tag): tag is string => typeof tag === "string")) : [];

  const accessScopes: MemoryAccessScope[] = ["project", "workroom"];
  const accessScope = typeof raw.accessScope === "string" && accessScopes.includes(raw.accessScope as MemoryAccessScope)
    ? (raw.accessScope as MemoryAccessScope)
    : "project";

  const statuses: MemoryStatus[] = ["active", "proposed", "superseded"];
  const status = typeof raw.status === "string" && statuses.includes(raw.status as MemoryStatus) ? (raw.status as MemoryStatus) : "active";

  const trusts: MemoryTrust[] = ["trusted", "untrusted"];
  const trust = typeof raw.trust === "string" && trusts.includes(raw.trust as MemoryTrust) ? (raw.trust as MemoryTrust) : "untrusted";

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: raw.id,
    kind: raw.kind as MemoryKind,
    text,
    source: raw.source as MemorySource,
    ...(stringValue(raw.taskId) ? { taskId: boundedField(stringValue(raw.taskId)!) } : {}),
    ...(stringValue(raw.branch) ? { branch: boundedField(stringValue(raw.branch)!) } : {}),
    author,
    ...(stringValue(raw.actorId) ? { actorId: boundedField(stringValue(raw.actorId)!) } : {}),
    createdAt,
    tags,
    accessScope,
    ...(stringValue(raw.requesterId) ? { requesterId: boundedField(stringValue(raw.requesterId)!) } : {}),
    ...(raw.internal === true ? { internal: true } : {}),
    status,
    trust
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function newMemoryId(): string {
  return `mem-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => redactSensitiveText(tag).trim().toLowerCase().slice(0, MAX_TAG_LENGTH)).filter(Boolean))].slice(0, MAX_TAGS);
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 20, 100));
}

function byRecencyDesc(a: MemoryEntry, b: MemoryEntry): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
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
