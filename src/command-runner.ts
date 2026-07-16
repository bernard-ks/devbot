import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { minimalChildEnvironment, sanitizeDiscordOutput } from "./security.js";
import type { ProjectEntry } from "./types.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_CONCURRENT_COMMANDS = 2;
const MAX_OUTPUT_BYTES = 2_000_000;
const TERMINATION_GRACE_MS = 750;
const TERMINATION_CONFIRM_MS = 2_000;

export type ProjectCommandKind = "test" | "build" | "lint" | "verify";

export interface ProjectCommandResult {
  projectName: string;
  kind: string;
  command: string;
  ok: boolean;
  exitCode: number | undefined;
  output: string;
  startedAt: string;
  finishedAt: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface ProjectCommandRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface CommandExecutionResult {
  ok: boolean;
  exitCode: number | undefined;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
}

export function configuredCommandNames(project: ProjectEntry): string[] {
  const builtIns = (["test", "build", "lint", "verify"] as ProjectCommandKind[]).filter(
    (kind) => project.metadata.commands[kind].length > 0
  );
  return [...builtIns, ...Object.keys(project.metadata.commands.presets)].sort();
}

/**
 * Resolves every command configured for a built-in validation kind. Presets are
 * single commands, so they are returned as a one-item list.
 */
export function resolveProjectCommands(project: ProjectEntry, name: string): string[] {
  const normalized = name.trim().toLowerCase();
  if (isProjectCommandKind(normalized)) {
    return [...project.metadata.commands[normalized]];
  }

  const preset = project.metadata.commands.presets[normalized];
  return preset ? [preset] : [];
}

/**
 * Backwards-compatible helper for callers that only need the first configured
 * command. Command execution uses resolveProjectCommands so arrays are not lost.
 */
export function resolveProjectCommand(project: ProjectEntry, name: string): string | undefined {
  return resolveProjectCommands(project, name)[0];
}

export async function runConfiguredProjectCommand(
  project: ProjectEntry,
  name: string,
  timeoutOrOptions: number | ProjectCommandRunOptions = DEFAULT_TIMEOUT_MS
): Promise<ProjectCommandResult> {
  const commands = resolveProjectCommands(project, name);
  if (commands.length === 0) {
    throw new Error(`No configured command named ${name} for ${project.name}. Add a command preset in that project's Devbot configuration.`);
  }

  const options = normalizeRunOptions(timeoutOrOptions);
  const startedAt = new Date().toISOString();
  const displayedCommand = commands.join(" && ");
  let releaseSlot: (() => void) | undefined;
  let runtimeHome: string | undefined;

  try {
    releaseSlot = await commandSlots.acquire(options.signal);
    if (options.signal?.aborted) {
      return commandFailure(project, name, displayedCommand, startedAt, "Command cancelled before it started.", {
        cancelled: true
      });
    }

    runtimeHome = await mkdtemp(path.join(tmpdir(), "devbot-command-"));
    const childEnvironment = minimalChildEnvironment();
    childEnvironment.HOME = runtimeHome;
    childEnvironment.USERPROFILE = runtimeHome;
    const deadline = Date.now() + options.timeoutMs;
    const output: string[] = [];
    let lastExitCode: number | undefined = 0;
    let timedOut = false;
    let cancelled = false;

    for (const command of commands) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        timedOut = true;
        lastExitCode = undefined;
        output.push("Command timed out before the next configured step started.");
        break;
      }

      const execution = await executeShellCommand(command, {
        cwd: project.root,
        env: childEnvironment,
        timeoutMs: remainingMs,
        ...(options.signal ? { signal: options.signal } : {})
      });
      lastExitCode = execution.exitCode;
      timedOut = execution.timedOut;
      cancelled = execution.cancelled;
      output.push(commands.length === 1
        ? execution.output
        : `$ ${command}\n${execution.output || "(no output)"}`);
      if (!execution.ok) break;
    }

    const ok = !timedOut && !cancelled && lastExitCode === 0 && output.length === commands.length;
    return {
      projectName: project.name,
      kind: name,
      command: sanitizeDiscordOutput(displayedCommand),
      ok,
      exitCode: lastExitCode,
      output: trimOutput(sanitizeDiscordOutput(output.filter(Boolean).join("\n\n"))),
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(timedOut ? { timedOut: true } : {}),
      ...(cancelled ? { cancelled: true } : {})
    };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      return commandFailure(project, name, displayedCommand, startedAt, "Command cancelled before it started.", {
        cancelled: true
      });
    }
    throw error;
  } finally {
    if (runtimeHome) {
      await rm(runtimeHome, { force: true, recursive: true }).catch(() => undefined);
    }
    releaseSlot?.();
  }
}

export function formatProjectCommandResult(result: ProjectCommandResult): string {
  const status = result.cancelled ? "cancelled" : result.timedOut ? "timed out" : result.ok ? "passed" : "failed";
  const exit = result.exitCode === undefined ? "" : `, exit ${result.exitCode}`;
  return [
    `\`${result.kind}\` ${status} for \`${result.projectName}\`${exit}.`,
    `Command: \`${result.command}\``,
    "",
    "Output:",
    codeBlock(result.output || "(no output)")
  ].join("\n");
}

function normalizeRunOptions(input: number | ProjectCommandRunOptions): Required<Pick<ProjectCommandRunOptions, "timeoutMs">> & Pick<ProjectCommandRunOptions, "signal"> {
  const requestedTimeout = typeof input === "number" ? input : input.timeoutMs;
  const timeoutMs = typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : DEFAULT_TIMEOUT_MS;
  return {
    timeoutMs,
    ...(typeof input === "object" && input.signal ? { signal: input.signal } : {})
  };
}

function commandFailure(
  project: ProjectEntry,
  name: string,
  command: string,
  startedAt: string,
  output: string,
  flags: { timedOut?: boolean; cancelled?: boolean }
): ProjectCommandResult {
  return {
    projectName: project.name,
    kind: name,
    command: sanitizeDiscordOutput(command),
    ok: false,
    exitCode: undefined,
    output,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(flags.timedOut ? { timedOut: true } : {}),
    ...(flags.cancelled ? { cancelled: true } : {})
  };
}

function executeShellCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }
): Promise<CommandExecutionResult> {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      detached,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let outputExceeded = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let closeObserved = false;
    let closeCode: number | null = null;
    let closeError: Error | undefined;
    let terminationRequested = false;
    let terminationConfirmed = true;

    const requestTermination = (): void => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminateProcessTree(child, detached);
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, detached, "SIGKILL");
        void waitForProcessTreeExit(child, detached, TERMINATION_CONFIRM_MS).then((confirmed) => {
          terminationConfirmed = confirmed;
          maybeFinish(true);
        });
      }, TERMINATION_GRACE_MS);
    };

    const append = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes <= MAX_OUTPUT_BYTES) chunks.push(buffer);
      if (outputBytes > MAX_OUTPUT_BYTES && !outputExceeded) {
        outputExceeded = true;
        requestTermination();
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, options.timeoutMs);
    timeout.unref();

    const onAbort = (): void => {
      cancelled = true;
      requestTermination();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const notices = [
        timedOut ? "Command timed out." : undefined,
        cancelled ? "Command cancelled." : undefined,
        outputExceeded ? `Command output exceeded ${MAX_OUTPUT_BYTES} bytes.` : undefined,
        !terminationConfirmed ? "The command process group could not be confirmed stopped." : undefined,
        closeError?.message
      ].filter((value): value is string => Boolean(value));
      const captured = Buffer.concat(chunks).toString("utf8");
      resolve({
        ok: closeCode === 0 && notices.length === 0,
        exitCode: typeof closeCode === "number" ? closeCode : undefined,
        output: [captured, ...notices].filter(Boolean).join(captured && notices.length > 0 ? "\n" : ""),
        timedOut,
        cancelled
      });
    };

    const maybeFinish = (force = false): void => {
      if (!closeObserved) return;
      if (terminationRequested && !force && isProcessGroupAlive(child, detached)) return;
      finish();
    };

    child.once("error", (error) => {
      closeObserved = true;
      closeError = error;
      maybeFinish();
    });
    child.once("close", (code) => {
      closeObserved = true;
      closeCode = code;
      maybeFinish();
    });
  });
}

function terminateProcessTree(child: ChildProcess, detached: boolean, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    if (detached) {
      process.kill(-child.pid, signal);
    } else if (child.exitCode === null) {
      child.kill(signal);
    }
  } catch {
    if (child.exitCode !== null) return;
    try {
      child.kill(signal);
    } catch {
      // The child exited between the liveness check and the signal.
    }
  }
}

function isProcessGroupAlive(child: ChildProcess, detached: boolean): boolean {
  if (!child.pid) return false;
  if (!detached) return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessTreeExit(child: ChildProcess, detached: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(child, detached)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessGroupAlive(child, detached);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isProjectCommandKind(value: string): value is ProjectCommandKind {
  return value === "test" || value === "build" || value === "lint" || value === "verify";
}

function trimOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 3_500 ? trimmed : `${trimmed.slice(-3_500)}\n[output truncated to last 3500 chars]`;
}

function codeBlock(value: string): string {
  return `\`\`\`\n${value.replace(/```/g, "'''")}\n\`\`\``;
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal: AbortSignal | undefined;
    onAbort: (() => void) | undefined;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }

    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.active -= 1;
        return;
      }
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.releaseFunction());
    };
  }
}

const commandSlots = new AsyncSemaphore(DEFAULT_MAX_CONCURRENT_COMMANDS);

function abortError(): Error {
  const error = new Error("The command was cancelled.");
  error.name = "AbortError";
  return error;
}
