import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultRuntimeStatePath } from "./runtime-paths.js";

interface RuntimeLockRecord {
  version: 1;
  pid: number;
  createdAt: string;
  ownerId: string;
  processIdentity?: string;
}

const ownedLocks = new Map<string, string>();

export function runtimeLockPath(configured?: string): string {
  return configured?.trim() ? path.resolve(configured.trim()) : defaultRuntimeStatePath("runtime.pid");
}

export function markRuntimeRunning(
  filePath = runtimeLockPath(),
  options: { hardenDirectory?: boolean } = {}
): void {
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && options.hardenDirectory !== false) chmodSync(directory, 0o700);

  const ownerId = randomBytes(16).toString("hex");
  const processIdentity = readProcessIdentity(process.pid);
  const record: RuntimeLockRecord = {
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerId,
    ...(processIdentity ? { processIdentity } : {})
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(resolvedPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      ownedLocks.set(resolvedPath, ownerId);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isRuntimeRunning(resolvedPath)) {
        throw new Error(`Another Devbot runtime already owns ${resolvedPath}.`);
      }
    }
  }

  throw new Error(`Unable to acquire Devbot runtime lock at ${resolvedPath}; another runtime is changing it.`);
}

export function isRuntimeRunning(filePath = runtimeLockPath()): boolean {
  const resolvedPath = path.resolve(filePath);
  const raw = readLockFile(resolvedPath);
  if (raw === undefined) return false;

  const record = parseRuntimeLock(raw);
  if (!record) {
    removeLockIfUnchanged(resolvedPath, raw);
    return false;
  }

  if (!isProcessAlive(record.pid)) {
    removeLockIfUnchanged(resolvedPath, raw);
    return false;
  }

  if (record.processIdentity) {
    const currentIdentity = readProcessIdentity(record.pid);
    if (currentIdentity && currentIdentity !== record.processIdentity) {
      removeLockIfUnchanged(resolvedPath, raw);
      return false;
    }
  }

  return true;
}

export function clearRuntimeLock(filePath = runtimeLockPath()): void {
  const resolvedPath = path.resolve(filePath);
  const raw = readLockFile(resolvedPath);
  if (raw === undefined) return;
  const record = parseRuntimeLock(raw);
  if (!record || record.pid !== process.pid) return;

  const expectedOwner = ownedLocks.get(resolvedPath);
  if (record.ownerId && record.ownerId !== expectedOwner) return;
  if (record.processIdentity) {
    const currentIdentity = readProcessIdentity(process.pid);
    if (currentIdentity && currentIdentity !== record.processIdentity) return;
  }

  removeLockIfUnchanged(resolvedPath, raw);
  ownedLocks.delete(resolvedPath);
}

function readLockFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseRuntimeLock(raw: string): RuntimeLockRecord | undefined {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return {
      version: 1,
      pid,
      createdAt: "1970-01-01T00:00:00.000Z",
      ownerId: ""
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<RuntimeLockRecord>;
    if (parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid ?? 0) <= 0
      || typeof parsed.createdAt !== "string"
      || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.ownerId !== "string"
      || !parsed.ownerId
      || (parsed.processIdentity !== undefined && typeof parsed.processIdentity !== "string")) {
      return undefined;
    }
    return parsed as RuntimeLockRecord;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Linux exposes a monotonic process start tick. macOS and other POSIX systems
 * expose a stable start timestamp through ps. If neither is available, PID
 * liveness remains the conservative fallback.
 */
function readProcessIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen > 0) {
        const fieldsAfterCommand = stat.slice(closeParen + 2).trim().split(/\s+/);
        const startTicks = fieldsAfterCommand[19];
        if (startTicks) return `linux-start-ticks:${startTicks}`;
      }
    } catch {
      return undefined;
    }
  }

  if (process.platform !== "win32") {
    try {
      const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000
      }).trim().replace(/\s+/g, " ");
      return startedAt ? `posix-start:${startedAt}` : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function removeLockIfUnchanged(filePath: string, expected: string): void {
  let current: string;
  try {
    current = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (current !== expected) return;
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
