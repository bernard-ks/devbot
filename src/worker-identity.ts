import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Strong, restart-durable identity for a detached worker process (a Codex child
 * that is spawned into its own process group with `detached: true`, so its pgid
 * equals its own pid). A bare pid is not enough: after a crash the OS can reuse
 * that pid for an unrelated process, so we also capture a start token that is
 * stable for the life of that specific process and changes if the pid is reused.
 */
export interface WorkerIdentity {
  pid: number;
  pgid: number;
  startToken?: string;
  recordedAt: string;
}

/**
 * `alive` — the exact recorded process is still running.
 * `dead` — the process is gone (or the pid now belongs to a different process).
 * `unknown` — liveness/identity could not be verified; callers must fail closed.
 */
export type WorkerLiveness = "alive" | "dead" | "unknown";

export function captureWorkerIdentity(pid: number, now = new Date()): WorkerIdentity {
  const identity: WorkerIdentity = {
    pid,
    // A `detached: true` child is a process-group leader (setsid), so pgid === pid.
    pgid: pid,
    recordedAt: now.toISOString()
  };
  const startToken = readProcessStartToken(pid);
  if (startToken) {
    identity.startToken = startToken;
  }
  return identity;
}

/**
 * Verifies whether the recorded worker is still the live process it was. Returns
 * `unknown` (fail closed) whenever the answer cannot be established with a strong
 * identity — an existing pid we cannot match to the recorded start token, a
 * platform without process-group identity, or a record captured without a token.
 */
export function probeWorker(worker: WorkerIdentity | undefined): WorkerLiveness {
  if (!worker || !Number.isInteger(worker.pid) || worker.pid <= 0) {
    return "unknown";
  }
  // No POSIX process-group identity on Windows; never claim a positive verdict.
  if (process.platform === "win32") {
    return "unknown";
  }

  let exists: boolean;
  try {
    process.kill(worker.pid, 0);
    exists = true;
  } catch (error) {
    // EPERM: the pid exists but is owned by another user (so it is not our
    // detached child); treat as present and let the start-token check decide.
    exists = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!exists) {
    return "dead";
  }

  // The pid is live. Without a recorded token, or a readable current token to
  // compare against, we cannot prove it is the same process — fail closed.
  if (!worker.startToken) {
    return "unknown";
  }
  const current = readProcessStartToken(worker.pid);
  if (!current) {
    return "unknown";
  }
  return current === worker.startToken ? "alive" : "dead";
}

/**
 * A value that is stable for the lifetime of a specific process and differs when
 * the pid is later reused. On Linux this is the boot id plus the process start
 * time (jiffies since boot); on macOS/BSD the absolute start timestamp from `ps`.
 */
function readProcessStartToken(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The comm field (index 2) may contain spaces/parens, so start parsing
      // after the final ')'. The remaining fields begin at field 3 (state),
      // making starttime (field 22) index 19 of the split remainder.
      const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim();
      const starttime = afterComm.split(/\s+/)[19];
      if (!starttime) {
        return undefined;
      }
      let bootId = "";
      try {
        bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      } catch {
        // boot id is optional; starttime alone still disambiguates within a boot.
      }
      return `${bootId}:${starttime}`;
    }

    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return started || undefined;
  } catch {
    return undefined;
  }
}
