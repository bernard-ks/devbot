import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export function runtimeLockPath(configured?: string): string {
  return path.resolve(configured?.trim() || ".devbot/runtime.pid");
}

export function markRuntimeRunning(filePath = runtimeLockPath()): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  try {
    writeFileSync(filePath, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (isRuntimeRunning(filePath)) {
      throw new Error(`Another Devbot runtime already owns ${filePath}.`);
    }
    writeFileSync(filePath, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
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
