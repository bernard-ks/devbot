import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface LegacyRuntimeEntry {
  name: string;
  override?: keyof NodeJS.ProcessEnv;
}

const LEGACY_RUNTIME_ENTRIES: readonly LegacyRuntimeEntry[] = [
  { name: "tasks.json", override: "DEVBOT_TASK_STORE" },
  { name: "executions.json", override: "DEVBOT_EXECUTION_STORE" },
  { name: "previews.json", override: "DEVBOT_PREVIEW_STORE" },
  { name: "preferences.json", override: "DEVBOT_PREFERENCES_STORE" },
  { name: "peers.json", override: "DEVBOT_PEER_STORE" },
  { name: "collab.json", override: "DEVBOT_COLLAB_STORE" },
  { name: "setup.json", override: "DEVBOT_SETUP_STORE" },
  { name: "screenshot-fixes.json", override: "DEVBOT_SNAPFIX_STORE" },
  { name: "memory", override: "DEVBOT_MEMORY_STORE" },
  { name: "captures" },
  { name: "commands.sha256" }
];

/**
 * Runtime ledgers can contain prompts, task output, Discord IDs, and screenshots.
 * Keep them outside every managed checkout so a coding agent cannot read them just
 * because its working directory is the repository it was asked to change.
 */
export function runtimeStateRoot(configured = process.env.DEVBOT_STATE_DIR): string {
  const value = configured?.trim();
  return path.resolve(value || path.join(homedir(), ".devbot", "state"));
}

export function runtimeStatePath(name: string, configuredRoot = process.env.DEVBOT_STATE_DIR): string {
  if (!name || path.isAbsolute(name) || name.split(/[\\/]+/).some((part) => part === "..")) {
    throw new Error("Runtime state names must be non-empty relative paths without parent traversal.");
  }
  return path.join(runtimeStateRoot(configuredRoot), name);
}

/** Pure path resolution. Migration is deliberately coordinated after runtime locks are held. */
export function defaultRuntimeStatePath(name: string): string {
  return runtimeStatePath(name);
}

export interface RuntimeMigrationOptions {
  legacyRoot?: string;
  targetRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Move recognized checkout-local runtime state into the protected root. Callers
 * must hold both the protected and legacy runtime locks before invoking this.
 * Repository metadata such as project.json is intentionally never moved.
 */
export function migrateLegacyRuntimeState(options: RuntimeMigrationOptions = {}): string[] {
  const legacyRoot = path.resolve(options.legacyRoot ?? path.join(process.cwd(), ".devbot"));
  const targetRoot = path.resolve(options.targetRoot ?? runtimeStateRoot());
  const environment = options.environment ?? process.env;
  if (legacyRoot === targetRoot || !existsSync(legacyRoot)) return [];
  assertSafeLegacyRuntimeRoot(legacyRoot);

  const entries = LEGACY_RUNTIME_ENTRIES.filter(({ override }) => !override || !environment[override]?.trim());
  for (const { name } of entries) {
    const source = path.join(legacyRoot, name);
    const target = path.join(targetRoot, name);
    if (existsSync(source) && existsSync(target)) {
      throw new Error(`Runtime migration found both legacy and protected state for ${name}; reconcile them before starting Devbot.`);
    }
    if (existsSync(source) && lstatSync(source).isSymbolicLink()) {
      throw new Error(`Refusing to migrate symlinked runtime state: ${source}`);
    }
  }

  const migrated: string[] = [];
  for (const { name } of entries) {
    const source = path.join(legacyRoot, name);
    if (!existsSync(source)) continue;
    const target = path.join(targetRoot, name);
    migrateLegacyEntry(source, target);
    migrated.push(name);
  }
  return migrated;
}

export function assertSafeLegacyRuntimeRoot(legacyRoot = path.resolve(".devbot")): void {
  if (existsSync(legacyRoot) && lstatSync(legacyRoot).isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked legacy runtime directory: ${legacyRoot}`);
  }
}

function migrateLegacyEntry(source: string, target: string): void {
  const sourceStat = lstatSync(source);
  mkdirSync(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(source, target, { recursive: sourceStat.isDirectory(), errorOnExist: true, force: false });
    rmSync(source, { recursive: sourceStat.isDirectory(), force: false });
  }

  if (process.platform !== "win32") {
    chmodSync(path.dirname(target), PRIVATE_DIRECTORY_MODE);
    chmodSync(target, sourceStat.isDirectory() ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
  }
}
