import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRuntimeRunning, runtimeLockPath } from "./runtime-lock.js";
import { runtimeStateRoot } from "./runtime-paths.js";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "./security.js";

const MANIFEST_NAME = "manifest.json";
const INDIVIDUAL_STORE_OVERRIDES = [
  "DEVBOT_TASK_STORE",
  "DEVBOT_EXECUTION_STORE",
  "DEVBOT_PREVIEW_STORE",
  "DEVBOT_PREFERENCES_STORE",
  "DEVBOT_PEER_STORE",
  "DEVBOT_COLLAB_STORE",
  "DEVBOT_SETUP_STORE",
  "DEVBOT_SNAPFIX_STORE",
  "DEVBOT_MEMORY_STORE"
] as const;

export interface StateBackupEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface StateBackupManifest {
  version: 1;
  createdAt: string;
  entries: StateBackupEntry[];
}

export async function createStateBackup(
  destination: string,
  options: { sourceRoot?: string; runtimeLock?: string; environment?: NodeJS.ProcessEnv } = {}
): Promise<StateBackupManifest> {
  const environment = options.environment ?? process.env;
  assertUnifiedStateRoot(environment);
  const requestedSourceRoot = path.resolve(options.sourceRoot ?? runtimeStateRoot(environment.DEVBOT_STATE_DIR));
  const requestedTarget = requireAbsoluteDestination(destination);
  if (isRuntimeRunning(options.runtimeLock ?? runtimeLockPath(environment.DEVBOT_RUNTIME_LOCK))) {
    throw new Error("Stop Devbot before backing up runtime state so the snapshot is internally consistent.");
  }
  const source = await lstat(requestedSourceRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Devbot runtime state does not exist at ${requestedSourceRoot}.`);
    throw error;
  });
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new Error("Devbot runtime state must be a real directory, not a symlink or special file.");
  }
  const sourceRoot = await realpath(requestedSourceRoot);
  const targetParent = await realpath(path.dirname(requestedTarget));
  const target = path.join(targetParent, path.basename(requestedTarget));
  assertSeparateTrees(sourceRoot, target);
  await assertDestinationAvailable(target);

  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.partial-${randomBytes(6).toString("hex")}`);
  await mkdir(temporary, { mode: PRIVATE_DIRECTORY_MODE });
  try {
    const entries = await copyTree(sourceRoot, temporary);
    const manifest: StateBackupManifest = { version: 1, createdAt: new Date().toISOString(), entries };
    await writePrivateFile(path.join(temporary, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, target);
    return manifest;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyStateBackup(directory: string): Promise<StateBackupManifest> {
  const requestedRoot = path.resolve(directory);
  const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("State backup must be a real directory, not a symlink or special file.");
  }
  const root = await realpath(requestedRoot);
  const manifestFile = path.join(root, MANIFEST_NAME);
  const manifestInfo = await lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error("Backup manifest must be a regular file.");
  }
  const raw = await readFile(manifestFile, "utf8");
  const manifest = parseManifest(raw);
  const actual = await listFiles(root, { excludeManifest: true });
  const expected = manifest.entries.map((entry) => entry.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Backup contents do not match the manifest file list.");
  }
  for (const entry of manifest.entries) {
    const file = path.join(root, ...entry.path.split("/"));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Backup entry is not a regular file: ${entry.path}`);
    if (info.size !== entry.bytes || (await sha256File(file)) !== entry.sha256) {
      throw new Error(`Backup integrity check failed for ${entry.path}.`);
    }
  }
  return manifest;
}

async function copyTree(sourceRoot: string, targetRoot: string): Promise<StateBackupEntry[]> {
  const files = await listFiles(sourceRoot);
  const entries: StateBackupEntry[] = [];
  for (const relative of files) {
    const source = path.join(sourceRoot, ...relative.split("/"));
    const target = path.join(targetRoot, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await copyFile(source, target);
    if (process.platform !== "win32") await chmod(target, PRIVATE_FILE_MODE);
    const info = await stat(target);
    entries.push({ path: relative, bytes: info.size, sha256: await sha256File(target) });
  }
  return entries;
}

async function listFiles(root: string, options: { excludeManifest?: boolean } = {}): Promise<string[]> {
  const output: string[] = [];
  await visit(root, "");
  return output.sort();

  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Refusing to back up or verify a symlinked runtime entry: ${relative}`);
      if (info.isDirectory()) {
        await visit(absolute, relative);
      } else if (info.isFile()) {
        if (!(options.excludeManifest && relative === MANIFEST_NAME)) output.push(relative);
      } else {
        throw new Error(`Refusing to back up or verify a special runtime entry: ${relative}`);
      }
    }
  }
}

function parseManifest(raw: string): StateBackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Backup manifest is not valid JSON.");
  }
  const candidate = value as Partial<StateBackupManifest>;
  if (candidate.version !== 1
    || typeof candidate.createdAt !== "string"
    || !Number.isFinite(Date.parse(candidate.createdAt))
    || !Array.isArray(candidate.entries)) {
    throw new Error("Backup manifest has an unsupported or invalid structure.");
  }
  const seen = new Set<string>();
  const entries = candidate.entries.map((rawEntry) => {
    const entry = rawEntry as Partial<StateBackupEntry>;
    if (!isSafeRelativePath(entry.path)
      || !Number.isSafeInteger(entry.bytes)
      || (entry.bytes ?? -1) < 0
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || seen.has(entry.path!)) {
      throw new Error("Backup manifest contains an invalid entry.");
    }
    seen.add(entry.path!);
    return entry as StateBackupEntry;
  });
  return { version: 1, createdAt: candidate.createdAt, entries };
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 500
    && !path.isAbsolute(value)
    && !value.split(/[\\/]+/).some((part) => !part || part === "." || part === "..");
}

function requireAbsoluteDestination(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("State backup destination must be an absolute path.");
  return path.resolve(value);
}

function assertSeparateTrees(source: string, target: string): void {
  const separator = path.sep;
  if (source === target || target.startsWith(`${source}${separator}`) || source.startsWith(`${target}${separator}`)) {
    throw new Error("State backup source and destination must not contain one another.");
  }
}

function assertUnifiedStateRoot(environment: NodeJS.ProcessEnv): void {
  const configured = INDIVIDUAL_STORE_OVERRIDES.filter((name) => environment[name]?.trim());
  if (configured.length > 0) {
    throw new Error(
      `State backup requires one unified DEVBOT_STATE_DIR; remove individual store overrides before backup: ${configured.join(", ")}.`
    );
  }
}

async function assertDestinationAvailable(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`State backup destination already exists: ${destination}`);
}

async function writePrivateFile(file: string, content: string): Promise<void> {
  await writeFile(file, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main(): Promise<void> {
  const [command, value, ...extra] = process.argv.slice(2);
  if (extra.length || !value || (command !== "create" && command !== "verify")) {
    throw new Error("Usage: state-backup <create|verify> /absolute/path/to/backup");
  }
  const result = command === "create" ? await createStateBackup(value) : await verifyStateBackup(value);
  console.log(`${command === "create" ? "Created" : "Verified"} Devbot state backup with ${result.entries.length} files at ${path.resolve(value)}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
