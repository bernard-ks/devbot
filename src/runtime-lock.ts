import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export function runtimeLockPath(configured?: string): string {
  return path.resolve(configured?.trim() || ".devbot/runtime.pid");
}

export function markRuntimeRunning(filePath = runtimeLockPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
}

export function isRuntimeRunning(filePath = runtimeLockPath()): boolean {
  if (!existsSync(filePath)) return false;
  const pid = Number(readFileSync(filePath, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    unlinkSync(filePath);
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    unlinkSync(filePath);
    return false;
  }
}

export function clearRuntimeLock(filePath = runtimeLockPath()): void {
  if (!existsSync(filePath)) return;
  const pid = Number(readFileSync(filePath, "utf8").trim());
  if (pid === process.pid) {
    unlinkSync(filePath);
  }
}
