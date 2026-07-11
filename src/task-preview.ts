import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  hardenPrivateDirectoryPermissions,
  hardenPrivateFilePermissions,
  minimalChildEnvironment,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  redactSensitiveText
} from "./security.js";
import type { TaskRecord } from "./task-store.js";
import { captureChildIdentity, terminateOrphanedChild, type ExecutionChildIdentity } from "./task-recovery.js";
import type { ProjectEntry } from "./types.js";

const PREVIEW_ID_PATTERN = /^prv-[a-f0-9]{12}$/;
const PREVIEW_COMMAND_NAMES = ["dev", "preview", "serve", "start"] as const;
const PACKAGE_SCRIPT_NAME_PATTERN = /^[a-z0-9:_-]{1,64}$/i;
const DEFAULT_LEDGER_FILE = path.resolve(".devbot", "previews.json");
const DEFAULT_MAX_PREVIEWS = 3;
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SIGKILL_DELAY_MS = 8_000;
const DEFAULT_EXIT_WAIT_MS = 12_000;
const DEFAULT_SAFETY_INTERVAL_MS = 1_000;
const MAX_OUTPUT_TAIL_CHARS = 1_500;
const MAX_FINISHED_INSTANCES = 20;

export type PreviewState = "pending" | "active" | "stopping" | "stopped" | "failed";
export type PreviewStopReason = "requested" | "expired" | "shutdown";
export type PreviewControlAction = "start" | "stop" | "status";

export interface PreviewCommand {
  source: "preset" | "package-script";
  name: string;
  command: string;
}

export interface PreviewInstance {
  id: string;
  taskId: string;
  projectName: string;
  branch: string | undefined;
  workspacePath: string;
  command: PreviewCommand;
  origin: string;
  port: number;
  pid: number | undefined;
  state: PreviewState;
  startedAt: string;
  expiresAt: string;
  stopReason?: PreviewStopReason;
  escalatedToSigkill?: boolean;
  cleanupPending?: boolean;
  message?: string;
}

export interface StartPreviewInput {
  taskId: string;
  projectName: string;
  branch?: string;
  workspacePath: string;
  command: PreviewCommand;
}

export type StartPreviewResult =
  | { ok: true; instance: PreviewInstance }
  | { ok: false; message: string; instance?: PreviewInstance };

export type StopPreviewResult =
  | { ok: true; instance: PreviewInstance }
  | { ok: false; message: string; instance?: PreviewInstance };

export type ResolvePreviewCommandResult =
  | { ok: true; command: PreviewCommand }
  | { ok: false; message: string };

export interface PreviewAccessContext {
  userId: string;
  controller: boolean;
  projectAllowed: boolean;
  safeMode: boolean;
}

export interface TaskPreviewManagerOptions {
  ledgerFile?: string;
  maxPreviews?: number;
  ttlMs?: number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  sigkillDelayMs?: number;
  exitWaitMs?: number;
  shell?: string;
  /**
   * Test seam for selecting the ephemeral loopback port. Production always uses
   * {@link reserveLoopbackPort}; tests inject a fixed port to drive the foreign
   * listener race deterministically. The selected port is only a hint: readiness
   * is gated on proven listener ownership, so a foreign process claiming this
   * port is refused rather than accepted.
   */
  reservePort?: () => Promise<number>;
  /** Test seam; production uses the current runtime platform. */
  platform?: NodeJS.Platform;
  /** Test seam for making isolated-home cleanup failures deterministic. */
  removeTempHome?: (candidate: string) => Promise<void>;
  /** Test seam; production checks active listeners once per second. */
  safetyIntervalMs?: number;
}

type PortOwnership = "owned" | "foreign" | "unsafe" | "unknown";

interface ListeningSocket {
  pid: number;
  name: string;
}

interface ManagedPreview {
  snapshot: PreviewInstance;
  child?: ChildProcess;
  tempHome?: string;
  outputTail: string;
  aborted: boolean;
  exitObserved: boolean;
  cleanupConfirmed: boolean;
  exitPromise?: Promise<void>;
  ttlTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  safetyTimer?: NodeJS.Timeout;
  safetyCheckRunning?: boolean;
  /**
   * POSIX process-group id of the spawned child (equal to its pid because the
   * child is spawned detached as a group leader). Every descendant the dev
   * command forks inherits this group, so a loopback listener owned by this
   * group is provably the managed child. Undefined on Windows.
   */
  groupId?: number;
  childIdentity?: ExecutionChildIdentity;
  cleanupPromise?: Promise<void>;
}

interface PreviewLedgerEntry {
  id: string;
  taskId: string;
  projectName: string;
  workspacePath: string;
  command: string;
  marker: string;
  port: number;
  origin: string;
  pid?: number;
  childIdentity?: ExecutionChildIdentity;
  tempHome?: string;
  createdAt: string;
  expiresAt: string;
}

interface PreviewLedgerFile {
  version: 1;
  previews: PreviewLedgerEntry[];
}

const execFileAsync = promisify(execFile);

export function isPreviewId(value: string): boolean {
  return PREVIEW_ID_PATTERN.test(value);
}

/** Workroom/internal preview origins never fall back into a broader project room. */
export function previewPublicationChannel(
  task: Pick<TaskRecord, "threadId" | "accessScope" | "internal">,
  projectRoomId?: string
): string | undefined {
  if (task.internal) return undefined;
  if (task.threadId) return task.threadId;
  if (task.accessScope === "workroom") return undefined;
  return projectRoomId;
}

/**
 * Central authorization for every preview control. Previews expose a running
 * project command, so start/stop/status all require project access and the
 * task requester or an approved controller. Starting is controller-only because
 * it spawns a configured project command; requesters may still inspect or stop
 * a preview that a controller started. Safe mode blocks only starting.
 */
export function authorizeTaskPreview(
  action: PreviewControlAction,
  task: Pick<TaskRecord, "id" | "requesterId">,
  context: PreviewAccessContext
): { allowed: true } | { allowed: false; message: string } {
  if (!context.projectAllowed) {
    return { allowed: false, message: "You are not allowed to use this task's project." };
  }
  if (action === "start" && !context.controller) {
    return {
      allowed: false,
      message: "Only the owner or an approved controller can start a task preview because it runs a project command."
    };
  }
  if (!context.controller && (!task.requesterId || task.requesterId !== context.userId)) {
    return {
      allowed: false,
      message: "Only the task requester, the owner, or an approved controller can manage this task's preview."
    };
  }
  if (action === "start" && context.safeMode) {
    return {
      allowed: false,
      message: [
        "Safe mode is on, so starting a preview is blocked because it runs a project command.",
        "`/task preview action:stop` and `action:status` still work.",
        "Set `DEVBOT_SAFE_MODE=false` and restart devbot to allow previews."
      ].join("\n")
    };
  }
  return { allowed: true };
}

/**
 * Resolves the only commands a preview may run: a `dev`/`preview`/`serve`/`start`
 * preset from the project's `.devbot/project.json`, or `npm run <script>` for an
 * allow-listed script declared in the workspace package.json. Free-text commands
 * are never accepted, and missing dependencies fail closed without installing.
 */
export async function resolvePreviewCommand(
  project: ProjectEntry,
  workspacePath: string
): Promise<ResolvePreviewCommandResult> {
  for (const name of PREVIEW_COMMAND_NAMES) {
    const preset = project.metadata.commands.presets[name];
    if (preset) {
      return { ok: true, command: { source: "preset", name, command: preset } };
    }
  }

  const scripts = await readPackageScripts(workspacePath);
  if (scripts) {
    const scriptName = PREVIEW_COMMAND_NAMES.find(
      (name) => typeof scripts[name] === "string" && (scripts[name] as string).trim() && PACKAGE_SCRIPT_NAME_PATTERN.test(name)
    );
    if (scriptName) {
      if (!(await directoryExists(path.join(workspacePath, "node_modules")))) {
        return {
          ok: false,
          message: [
            `The task workspace declares an npm \`${scriptName}\` script but has no installed dependencies (node_modules is missing).`,
            "Install dependencies in the task workspace yourself before starting a preview; Devbot does not install them."
          ].join("\n")
        };
      }
      return { ok: true, command: { source: "package-script", name: scriptName, command: `npm run ${scriptName}` } };
    }
  }

  return {
    ok: false,
    message: [
      "No preview command is configured for this project.",
      "Add a `dev`, `preview`, `serve`, or `start` preset to `.devbot/project.json`, or declare one of those scripts in package.json."
    ].join("\n")
  };
}

/**
 * Runs loopback-only dev servers from isolated task worktrees.
 *
 * This is the managed-preview surface other evidence features (visual diff,
 * video proof, authenticated tunnels) are expected to build on: call
 * `start()` with a task workspace and a command from `resolvePreviewCommand`,
 * read the exact observed origin from the returned instance, and release it
 * with `stop()`. Origins are always `http://127.0.0.1:<ephemeral port>`; the
 * manager never binds or forwards anything non-loopback.
 *
 * Readiness is bound to the exact managed child, not merely a responsive port.
 * The ephemeral port is chosen with a brief bind-then-close, which leaves a
 * window in which a foreign process could claim it (a TOCTOU). Rather than
 * trust any HTTP responder on that port, `start()` proves the loopback listener
 * belongs to the managed child's process group before reporting the preview
 * active, and `stop()` proves the child's owned listener is gone before
 * reporting success. A foreign server that races for the port is refused and is
 * never presented as the task preview.
 */
export class TaskPreviewManager {
  private readonly instances = new Map<string, ManagedPreview>();
  private readonly ledgerFile: string;
  private readonly maxPreviews: number;
  private readonly ttlMs: number;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sigkillDelayMs: number;
  private readonly exitWaitMs: number;
  private readonly shell: string;
  private readonly reservePort: () => Promise<number>;
  private readonly platform: NodeJS.Platform;
  private readonly removeTempHome: (candidate: string) => Promise<void>;
  private readonly safetyIntervalMs: number;
  private ledger: PreviewLedgerFile | undefined;
  private ledgerTail: Promise<void> = Promise.resolve();
  private reconciliation: Promise<string[]> | undefined;
  private shuttingDown = false;

  constructor(options: TaskPreviewManagerOptions = {}) {
    this.ledgerFile = path.resolve(options.ledgerFile ?? DEFAULT_LEDGER_FILE);
    this.maxPreviews = Math.max(1, Math.floor(options.maxPreviews ?? DEFAULT_MAX_PREVIEWS));
    this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS));
    this.readyTimeoutMs = Math.max(1_000, Math.floor(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS));
    this.pollIntervalMs = Math.max(20, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.sigkillDelayMs = Math.max(50, Math.floor(options.sigkillDelayMs ?? DEFAULT_SIGKILL_DELAY_MS));
    this.exitWaitMs = Math.max(this.sigkillDelayMs + 1_000, Math.floor(options.exitWaitMs ?? DEFAULT_EXIT_WAIT_MS));
    this.shell = options.shell ?? (process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh");
    this.reservePort = options.reservePort ?? reserveLoopbackPort;
    this.platform = options.platform ?? process.platform;
    this.removeTempHome = options.removeTempHome ?? ((candidate) => rm(candidate, { force: true, recursive: true }));
    this.safetyIntervalMs = Math.max(100, Math.floor(options.safetyIntervalMs ?? DEFAULT_SAFETY_INTERVAL_MS));
  }

  async start(input: StartPreviewInput): Promise<StartPreviewResult> {
    if (this.shuttingDown) {
      return { ok: false, message: "Devbot is shutting down; no new previews can start." };
    }
    if (this.platform === "win32") {
      return {
        ok: false,
        message: "Managed task previews are unavailable on Windows until listener ownership can be verified safely."
      };
    }
    try {
      await this.reconcile();
    } catch (error) {
      return {
        ok: false,
        message: `Preview startup recovery did not complete safely, so no new preview was started: ${redactSensitiveText((error as Error).message)}`
      };
    }

    const unresolved = (this.ledger?.previews ?? []).filter((entry) => !this.instances.has(entry.id));
    if (unresolved.length > 0) {
      return {
        ok: false,
        message: `A preview from the previous runtime still has unconfirmed cleanup (${unresolved[0]!.id}); no new preview can start until it is reconciled.`
      };
    }

    const existing = this.findOpenForTask(input.taskId);
    if (existing) {
      return {
        ok: false,
        message: `Task \`${input.taskId}\` already has an open preview (${existing.snapshot.state}). Stop it before starting another.`,
        instance: cloneInstance(existing.snapshot)
      };
    }
    if (this.openCount() >= this.maxPreviews) {
      return {
        ok: false,
        message: `The preview limit (${this.maxPreviews}) has been reached. Stop an existing preview before starting another.`
      };
    }
    const id = newPreviewId();
    const startedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const managed: ManagedPreview = {
      snapshot: {
        id,
        taskId: input.taskId,
        projectName: input.projectName,
        branch: input.branch,
        workspacePath: input.workspacePath,
        command: input.command,
        origin: "",
        port: 0,
        pid: undefined,
        state: "pending",
        startedAt,
        expiresAt
      },
      outputTail: "",
      aborted: false,
      exitObserved: false,
      cleanupConfirmed: false
    };
    // Reserve capacity synchronously before the first post-admission await so
    // concurrent Discord interactions cannot both pass the per-task/global
    // checks and spawn duplicate preview commands.
    this.instances.set(id, managed);

    if (!(await directoryExists(input.workspacePath))) {
      const message = `The isolated task workspace no longer exists at \`${input.workspacePath}\`, so there is nothing to preview.`;
      managed.snapshot.state = "failed";
      managed.snapshot.message = message;
      managed.cleanupConfirmed = true;
      this.instances.delete(id);
      return { ok: false, message };
    }

    try {
      const port = await this.reservePort();
      const origin = `http://127.0.0.1:${port}`;
      managed.snapshot.port = port;
      managed.snapshot.origin = origin;
      managed.tempHome = await mkdtemp(path.join(tmpdir(), "devbot-preview-home-"));

      await this.writeLedgerEntry(managed);
      if (managed.aborted) {
        await this.finalize(managed, "stopped", managed.snapshot.message);
      } else {
        this.spawnPreviewProcess(managed);
        if (managed.snapshot.pid !== undefined) {
          const identity = await capturePreviewIdentity(managed.snapshot.pid, this.pollIntervalMs);
          if (!identity || identity.groupId !== managed.snapshot.pid) {
            throw new Error("The preview worker could not be bound to a durable isolated process-group identity.");
          }
          managed.childIdentity = identity;
          managed.groupId = identity.groupId;
          await this.writeLedgerEntry(managed);
        }
        if (managed.aborted) {
          this.terminate(managed);
          await this.awaitExit(managed);
        } else {
          // The shell waits on this private stdin gate. No configured command
          // can run until its exact worker identity and temporary home are
          // durably persisted above.
          managed.child?.stdin?.end("start\n");
          await this.waitForReady(managed);
        }
      }
    } catch (error) {
      const message = `The preview could not start: ${redactSensitiveText((error as Error).message)}`;
      if (managed.child) {
        // A child that failed before the durable identity write is still ours
        // in this runtime and is still blocked on the private stdin gate. Reap
        // its process group and observe exit before clearing the pre-start
        // ledger entry; never leave a gated shell behind.
        managed.aborted = true;
        managed.snapshot.state = "stopping";
        managed.snapshot.message = message;
        this.terminate(managed);
        await this.awaitExit(managed);
        managed.snapshot.state = "failed";
      } else {
        await this.finalize(managed, "failed", message);
      }
    }

    const snapshot = cloneInstance(managed.snapshot);
    if (snapshot.state === "active") {
      return { ok: true, instance: snapshot };
    }
    return {
      ok: false,
      message: snapshot.message ?? `The preview did not become ready (state: ${snapshot.state}).`,
      instance: snapshot
    };
  }

  async stop(id: string, reason: PreviewStopReason): Promise<StopPreviewResult> {
    const managed = this.instances.get(id);
    if (!managed) {
      return { ok: false, message: "That preview is no longer tracked; the control has expired." };
    }
    const state = managed.snapshot.state;
    if (state === "stopped" || state === "failed") {
      if (!managed.cleanupConfirmed) {
        await this.finalize(managed, state, managed.snapshot.message);
      }
      return this.reportStopOutcome(managed);
    }
    if (state === "stopping") {
      await this.awaitExit(managed);
      return this.reportStopOutcome(managed);
    }

    managed.aborted = true;
    if (state === "pending") {
      managed.snapshot.message = "The preview was stopped before it became ready.";
    }
    managed.snapshot.state = "stopping";
    managed.snapshot.stopReason = reason;
    if (!managed.child) {
      await this.awaitFinalized(managed);
      return this.reportStopOutcome(managed);
    }
    this.terminate(managed);
    await this.awaitExit(managed);
    return this.reportStopOutcome(managed);
  }

  status(id: string): PreviewInstance | undefined {
    const managed = this.instances.get(id);
    return managed ? cloneInstance(managed.snapshot) : undefined;
  }

  list(taskId?: string): PreviewInstance[] {
    return [...this.instances.values()]
      .filter((managed) => !taskId || managed.snapshot.taskId === taskId)
      .map((managed) => cloneInstance(managed.snapshot));
  }

  latestUnresolved(taskId: string): PreviewInstance | undefined {
    const managed = [...this.instances.values()]
      .filter((candidate) => candidate.snapshot.taskId === taskId && !candidate.cleanupConfirmed)
      .at(-1);
    return managed ? cloneInstance(managed.snapshot) : undefined;
  }

  async stopAll(reason: PreviewStopReason): Promise<void> {
    this.shuttingDown = reason === "shutdown";
    const open = [...this.instances.values()].filter((managed) => !managed.cleanupConfirmed);
    await Promise.all(open.map((managed) => this.stop(managed.snapshot.id, reason).catch(() => undefined)));
  }

  /**
   * Reconciles persisted previews exactly once for this runtime. `start()`
   * awaits the same promise, so Discord interactions cannot race startup
   * cleanup or observe a separately loaded ledger snapshot.
   */
  async reconcile(): Promise<string[]> {
    this.reconciliation ??= this.reconcilePersisted();
    return this.reconciliation;
  }

  /** Reconciles persisted previews using the same pid/start-time/command/group identity as task recovery. */
  private async reconcilePersisted(): Promise<string[]> {
    const notes: string[] = [];
    const ledger = await this.loadLedger();
    if (ledger.previews.length === 0) {
      return notes;
    }
    if (this.platform === "win32") {
      notes.push("Preview reconciliation is unsupported on Windows; entries with a recorded worker are retained without signaling.");
      for (const entry of [...ledger.previews]) {
        if (entry.pid !== undefined) continue;
        if (entry.tempHome) {
          try {
            await this.removeManagedTempHome(entry.tempHome);
          } catch (error) {
            notes.push(`Could not remove the isolated home for preview ${entry.id}; keeping its ledger entry: ${(error as Error).message}`);
            continue;
          }
        }
        await this.mutateLedger((state) => {
          state.previews = state.previews.filter((candidate) => candidate.id !== entry.id);
        });
      }
      return notes;
    }

    for (const entry of [...ledger.previews]) {
      if (entry.pid === undefined) {
        notes.push(`Preview ${entry.id} never recorded a worker; clearing its gated pre-start state without signaling.`);
      } else if (!entry.childIdentity || entry.childIdentity.pid !== entry.pid) {
        notes.push(
          `Preview ${entry.id} has no complete durable process identity; refusing to signal pid ${entry.pid} and keeping its ledger entry.`
        );
        continue;
      } else {
        const outcome = await terminateOrphanedChild(entry.childIdentity, {
          gracePeriodMs: this.sigkillDelayMs,
          killWaitMs: Math.max(0, this.exitWaitMs - this.sigkillDelayMs),
          pollIntervalMs: this.pollIntervalMs
        });
        if (outcome === "kill-unconfirmed" || outcome === "unverifiable") {
          notes.push(`Could not confirm cleanup of preview ${entry.id} (pid ${entry.pid}; ${outcome}); keeping its ledger entry.`);
          continue;
        }
        notes.push(
          outcome === "not-ours"
            ? `Pid ${entry.pid} no longer belongs to preview ${entry.id}; it was left untouched and stale metadata was cleared.`
            : `Reconciled preview ${entry.id} for task ${entry.taskId}: ${outcome}.`
        );
      }
      if (entry.tempHome) {
        try {
          await this.removeManagedTempHome(entry.tempHome);
        } catch (error) {
          notes.push(`Could not remove the isolated home for preview ${entry.id}; keeping its ledger entry: ${(error as Error).message}`);
          continue;
        }
      }
      await this.mutateLedger((state) => {
        state.previews = state.previews.filter((candidate) => candidate.id !== entry.id);
      });
    }
    return notes;
  }

  private openCount(): number {
    return [...this.instances.values()].filter((managed) => !managed.cleanupConfirmed).length;
  }

  private findOpenForTask(taskId: string): ManagedPreview | undefined {
    return [...this.instances.values()].find(
      (managed) => managed.snapshot.taskId === taskId && !managed.cleanupConfirmed
    );
  }

  private spawnPreviewProcess(managed: ManagedPreview): void {
    const environment = minimalChildEnvironment();
    environment.HOME = managed.tempHome;
    environment.USERPROFILE = managed.tempHome;
    environment.PORT = String(managed.snapshot.port);
    environment.HOST = "127.0.0.1";

    const shellArguments = process.platform === "win32"
      ? ["/d", "/s", "/c", managed.snapshot.command.command]
      : [
          "-c",
          [
            "IFS= read -r _devbot_gate || exit 125",
            // Run the configured command in a child shell. Keeping this outer
            // gated shell as the process-group leader gives restart recovery a
            // stable identity even when the configured command uses `exec`,
            // `exit`, traps, or other shell control flow.
            "\"$1\" -c \"$2\"",
            "_devbot_status=$?",
            "exit \"$_devbot_status\""
          ].join("\n"),
          previewMarker(managed.snapshot.id),
          this.shell,
          managed.snapshot.command.command
        ];
    const child = spawn(this.shell, shellArguments, {
      cwd: managed.snapshot.workspacePath,
      env: environment,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    managed.child = child;
    managed.snapshot.pid = child.pid;
    if (child.pid !== undefined && this.platform !== "win32") {
      // `detached: true` makes the spawned shell its process-group leader. Keep
      // this in-memory handle immediately so even a failure while capturing or
      // persisting the stronger restart identity can reap the still-gated shell.
      managed.groupId = child.pid;
    }

    const appendOutput = (chunk: Buffer) => {
      managed.outputTail = `${managed.outputTail}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.stdin?.on("error", (error) => {
      if (!managed.exitObserved) managed.snapshot.message = `The preview start gate failed: ${redactSensitiveText(error.message)}`;
    });

    managed.exitPromise = new Promise((resolve) => {
      let settled = false;
      const settle = (message?: string) => {
        if (settled) return;
        settled = true;
        managed.exitObserved = true;
        void this.onChildGone(managed, message).finally(resolve);
      };
      child.once("error", (error) => settle(`The preview command could not run: ${redactSensitiveText(error.message)}`));
      child.once("exit", () => settle());
    });
  }

  private async waitForReady(managed: ManagedPreview): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    const verifyOwnership = process.platform !== "win32" && managed.groupId !== undefined;
    while (Date.now() < deadline) {
      if (managed.aborted || managed.snapshot.state !== "pending") {
        await this.awaitExit(managed);
        return;
      }
      if (managed.exitObserved) {
        await this.awaitExit(managed);
        return;
      }
      if (verifyOwnership) {
        const ownership = await classifyPortListener(managed.snapshot.port, managed.groupId);
        if (managed.aborted || managed.exitObserved || managed.snapshot.state !== "pending") {
          await this.awaitExit(managed);
          return;
        }
        if (ownership === "foreign" || ownership === "unsafe") {
          managed.aborted = true;
          managed.snapshot.state = "stopping";
          this.terminate(managed);
          await this.awaitExit(managed);
          managed.snapshot.state = "failed";
          managed.snapshot.message = withOutputTail(
            ownership === "unsafe"
              ? "The managed command opened a non-loopback listener, so Devbot stopped it and refused to expose the preview."
              : "A different process already owns this preview's loopback port, so Devbot refused to attach to it and started no preview.",
            managed.outputTail
          );
          return;
        }
        if (ownership !== "owned") {
          // Never probe an unknown or foreign loopback service. Wait until the
          // selected listener is first proven to belong to the managed group.
          await sleep(this.pollIntervalMs);
          continue;
        }
      }
      if (await respondsOnLoopback(managed.snapshot.port)) {
        if (managed.aborted || managed.exitObserved || managed.snapshot.state !== "pending") {
          await this.awaitExit(managed);
          return;
        }
        if (verifyOwnership && (await classifyPortListener(managed.snapshot.port, managed.groupId)) !== "owned") {
          await sleep(this.pollIntervalMs);
          continue;
        }
        managed.snapshot.state = "active";
        managed.snapshot.expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
        managed.ttlTimer = setTimeout(() => {
          void this.stop(managed.snapshot.id, "expired").catch(() => undefined);
        }, this.ttlMs);
        managed.ttlTimer.unref();
        managed.safetyTimer = setInterval(() => {
          void this.enforceListenerBoundary(managed);
        }, this.safetyIntervalMs);
        managed.safetyTimer.unref();
        return;
      }
      await sleep(this.pollIntervalMs);
    }

    managed.aborted = true;
    managed.snapshot.state = "stopping";
    this.terminate(managed);
    await this.awaitExit(managed);
    managed.snapshot.state = "failed";
    managed.snapshot.message = withOutputTail(
      `The preview did not respond on its loopback origin within ${Math.round(this.readyTimeoutMs / 1000)}s under Devbot's ownership, and was stopped.`,
      managed.outputTail
    );
  }

  private terminate(managed: ManagedPreview): void {
    const pid = managed.snapshot.pid;
    if (pid === undefined || managed.exitObserved) {
      return;
    }
    signalPreviewProcess(pid, "SIGTERM");
    managed.killTimer = setTimeout(() => {
      if (!managed.exitObserved) {
        managed.snapshot.escalatedToSigkill = true;
        signalPreviewProcess(pid, "SIGKILL");
      }
    }, this.sigkillDelayMs);
    managed.killTimer.unref();
  }

  private async awaitFinalized(managed: ManagedPreview): Promise<void> {
    const deadline = Date.now() + this.exitWaitMs;
    while (Date.now() < deadline) {
      const state = managed.snapshot.state;
      if (state === "stopped" || state === "failed") return;
      await sleep(this.pollIntervalMs);
    }
    managed.snapshot.message = "The preview did not confirm it stopped in time.";
  }

  private async awaitExit(managed: ManagedPreview): Promise<void> {
    if (!managed.exitPromise) {
      await this.finalize(managed, managed.aborted ? "stopped" : "failed", managed.snapshot.message);
      return;
    }
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), this.exitWaitMs);
      timeoutHandle.unref();
    });
    const exited = managed.exitPromise.then(() => "exited" as const);
    const outcome = await Promise.race([exited, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (outcome === "timeout") {
      managed.snapshot.message = withOutputTail(
        `The preview process (pid ${managed.snapshot.pid ?? "unknown"}) did not exit after SIGTERM and SIGKILL; its ledger entry is kept for the next restart.`,
        managed.outputTail
      );
    }
  }

  private async onChildGone(managed: ManagedPreview, message?: string): Promise<void> {
    if (managed.killTimer) clearTimeout(managed.killTimer);
    const state = managed.snapshot.state;
    if (state === "stopping" || managed.aborted) {
      await this.finalize(managed, "stopped", message ?? managed.snapshot.message);
      return;
    }
    if (state === "pending") {
      await this.finalize(
        managed,
        "failed",
        message ?? withOutputTail("The preview command exited before it started serving.", managed.outputTail)
      );
      return;
    }
    await this.finalize(
      managed,
      "failed",
      message ?? withOutputTail("The preview process exited unexpectedly.", managed.outputTail)
    );
  }

  private async finalize(managed: ManagedPreview, state: "stopped" | "failed", message?: string): Promise<void> {
    if (managed.cleanupPromise) {
      await managed.cleanupPromise;
      return;
    }
    const operation = this.finalizeResources(managed, state, message);
    managed.cleanupPromise = operation;
    try {
      await operation;
    } finally {
      delete managed.cleanupPromise;
    }
  }

  private async finalizeResources(managed: ManagedPreview, state: "stopped" | "failed", message?: string): Promise<void> {
    if (managed.ttlTimer) clearTimeout(managed.ttlTimer);
    if (managed.killTimer) clearTimeout(managed.killTimer);
    if (managed.safetyTimer) clearInterval(managed.safetyTimer);
    managed.snapshot.state = state;
    if (message) {
      managed.snapshot.message = redactSensitiveText(message);
    }
    // The leader exiting does not mean the managed work is gone: a preset can
    // background or unref a same-process-group child that keeps serving the
    // loopback origin after its leader is dead. Reap the whole group and prove
    // it is quiescent before clearing durable state; an unconfirmed cleanup
    // keeps the ledger entry and isolated home so a restart can finish the job,
    // mirroring the tunnel/recovery fail-closed conventions in this repo.
    const quiescent = await this.reapManagedGroup(managed);
    if (!quiescent) {
      managed.snapshot.cleanupPending = true;
      managed.snapshot.message = redactSensitiveText(
        withOutputTail(
          `The preview leader exited but its process group (pgid ${managed.groupId ?? "unknown"}) is not yet quiescent; its ledger entry and isolated home are kept for the next restart.`,
          managed.outputTail
        )
      );
      this.pruneFinished();
      return;
    }
    if (managed.tempHome) {
      try {
        await this.removeManagedTempHome(managed.tempHome);
        delete managed.tempHome;
      } catch (error) {
        managed.snapshot.cleanupPending = true;
        managed.snapshot.message = redactSensitiveText(
          `The preview process stopped, but its isolated home could not be removed; durable cleanup is retained: ${(error as Error).message}`
        );
        this.pruneFinished();
        return;
      }
    }
    try {
      await this.mutateLedger((ledger) => {
        ledger.previews = ledger.previews.filter((entry) => entry.id !== managed.snapshot.id);
      });
    } catch (error) {
      managed.snapshot.cleanupPending = true;
      managed.snapshot.message = redactSensitiveText(
        `The preview process stopped, but durable cleanup state could not be cleared: ${(error as Error).message}`
      );
      this.pruneFinished();
      return;
    }
    managed.cleanupConfirmed = true;
    delete managed.snapshot.cleanupPending;
    this.pruneFinished();
  }

  /** Continuously enforces the local-only boundary after readiness, not just at startup. */
  private async enforceListenerBoundary(managed: ManagedPreview): Promise<void> {
    if (
      managed.safetyCheckRunning ||
      managed.snapshot.state !== "active" ||
      managed.groupId === undefined ||
      managed.cleanupConfirmed
    ) {
      return;
    }
    managed.safetyCheckRunning = true;
    try {
      const ownership = await classifyPortListener(managed.snapshot.port, managed.groupId);
      if (ownership !== "unsafe" || managed.snapshot.state !== "active") return;
      managed.aborted = true;
      managed.snapshot.state = "stopping";
      managed.snapshot.message =
        "The managed command opened a non-loopback listener after startup, so Devbot stopped the entire preview process group.";
      this.terminate(managed);
      await this.awaitExit(managed);
      managed.snapshot.state = "failed";
    } finally {
      managed.safetyCheckRunning = false;
    }
  }

  /**
   * Terminates the managed child's entire process group and proves it is
   * quiescent. Because the child is spawned detached as a group leader, every
   * descendant the dev command forks shares its process group, so signaling
   * `kill(-pgid)` reaches an orphaned same-group child that outlived the leader.
   * Quiescence requires BOTH that the group is gone (`kill(-pgid, 0)` fails) and
   * that no owned listener still holds the port; until both are proven the
   * caller retains durable state. Returns true immediately on Windows or when no
   * group was recorded (nothing to reap).
   */
  private async reapManagedGroup(managed: ManagedPreview): Promise<boolean> {
    const groupId = managed.groupId;
    if (process.platform === "win32" || groupId === undefined) {
      return true;
    }
    if (await this.managedGroupQuiescent(managed, groupId)) {
      return true;
    }
    signalPreviewProcess(groupId, "SIGTERM");
    const deadline = Date.now() + this.exitWaitMs;
    const killAt = Date.now() + this.sigkillDelayMs;
    let escalated = false;
    while (Date.now() < deadline) {
      if (await this.managedGroupQuiescent(managed, groupId)) {
        return true;
      }
      if (!escalated && Date.now() >= killAt) {
        escalated = true;
        managed.snapshot.escalatedToSigkill = true;
        signalPreviewProcess(groupId, "SIGKILL");
      }
      await sleep(this.pollIntervalMs);
    }
    return this.managedGroupQuiescent(managed, groupId);
  }

  /**
   * Proves the managed child's process group is fully quiescent: no member of
   * the group is still alive and no listener the group owned still holds the
   * port. The group-liveness probe (`kill(-pgid, 0)`) is cheap and is checked
   * first, so the `lsof`/`ps` attribution only runs once the group is already
   * gone — the point at which a lingering owned listener is provably impossible
   * but is confirmed anyway to fail closed against pid/pgid reuse.
   */
  private async managedGroupQuiescent(managed: ManagedPreview, groupId: number): Promise<boolean> {
    if (processGroupExists(groupId)) {
      return false;
    }
    if (!managed.snapshot.port) {
      return true;
    }
    return (await classifyPortListener(managed.snapshot.port, groupId)) !== "owned";
  }

  private async reportStopOutcome(managed: ManagedPreview): Promise<StopPreviewResult> {
    if (!managed.exitObserved && managed.snapshot.pid !== undefined) {
      return {
        ok: false,
        message: managed.snapshot.message ?? "The preview process has not confirmed its exit yet.",
        instance: cloneInstance(managed.snapshot)
      };
    }
    if (!managed.cleanupConfirmed) {
      return {
        ok: false,
        message:
          managed.snapshot.message ??
          "The preview process exited, but process-group, listener, or durable resource cleanup is not yet confirmed.",
        instance: cloneInstance(managed.snapshot)
      };
    }
    return { ok: true, instance: cloneInstance(managed.snapshot) };
  }

  private pruneFinished(): void {
    const finished = [...this.instances.values()].filter(
      (managed) =>
        managed.cleanupConfirmed &&
        (managed.snapshot.state === "stopped" || managed.snapshot.state === "failed")
    );
    for (const managed of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_INSTANCES))) {
      this.instances.delete(managed.snapshot.id);
    }
  }

  private async writeLedgerEntry(managed: ManagedPreview): Promise<void> {
    await this.mutateLedger((ledger) => {
      const entry: PreviewLedgerEntry = {
        id: managed.snapshot.id,
        taskId: managed.snapshot.taskId,
        projectName: managed.snapshot.projectName,
        workspacePath: managed.snapshot.workspacePath,
        command: managed.snapshot.command.command,
        marker: previewMarker(managed.snapshot.id),
        port: managed.snapshot.port,
        origin: managed.snapshot.origin,
        ...(managed.snapshot.pid !== undefined ? { pid: managed.snapshot.pid } : {}),
        ...(managed.childIdentity ? { childIdentity: managed.childIdentity } : {}),
        ...(managed.tempHome ? { tempHome: managed.tempHome } : {}),
        createdAt: managed.snapshot.startedAt,
        expiresAt: managed.snapshot.expiresAt
      };
      ledger.previews = [...ledger.previews.filter((candidate) => candidate.id !== entry.id), entry];
    });
  }

  private async mutateLedger(mutation: (ledger: PreviewLedgerFile) => void): Promise<void> {
    const operation = this.ledgerTail.then(async () => {
      const ledger = await this.loadLedger();
      mutation(ledger);
      await this.saveLedger(ledger);
    });
    this.ledgerTail = operation.catch(() => undefined);
    await operation;
  }

  private async loadLedger(): Promise<PreviewLedgerFile> {
    if (this.ledger) {
      return this.ledger;
    }
    try {
      const parsed = JSON.parse(await readFile(this.ledgerFile, "utf8")) as unknown;
      await hardenPrivateFilePermissions(this.ledgerFile);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Preview state must be a JSON object.");
      }
      const raw = parsed as { version?: unknown; previews?: unknown };
      if (raw.version !== undefined && raw.version !== 1) {
        throw new Error(`Unsupported preview state version: ${String(raw.version)}.`);
      }
      this.ledger = {
        version: 1,
        previews: Array.isArray(raw.previews)
          ? raw.previews.map(normalizeLedgerEntry).filter((entry): entry is PreviewLedgerEntry => entry !== undefined)
          : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read preview state at ${this.ledgerFile}: ${(error as Error).message}`, { cause: error });
      }
      this.ledger = { version: 1, previews: [] };
    }
    return this.ledger;
  }

  private async saveLedger(ledger: PreviewLedgerFile): Promise<void> {
    const directory = path.dirname(this.ledgerFile);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await hardenPrivateDirectoryPermissions(directory);
    const tempFile = `${this.ledgerFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    await rename(tempFile, this.ledgerFile);
  }

  private async removeManagedTempHome(candidate: string): Promise<void> {
    assertManagedTempHome(candidate);
    await this.removeTempHome(candidate);
  }
}

export function formatPreviewInstance(instance: PreviewInstance): string {
  return [
    `Preview \`${instance.id}\` for task \`${instance.taskId}\` on \`${instance.projectName}\`: ${instance.state}.`,
    instance.branch ? `Branch: \`${instance.branch}\` (isolated worktree)` : undefined,
    instance.state === "active" ? `Origin: <${instance.origin}> (loopback only, this machine)` : undefined,
    instance.state === "active" ? `Expires: ${new Date(instance.expiresAt).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}` : undefined,
    `Command: \`${redactSensitiveText(instance.command.command).replace(/`/g, "'")}\` (${instance.command.source} \`${instance.command.name}\`)`,
    instance.escalatedToSigkill ? "The process ignored SIGTERM and required SIGKILL." : undefined,
    instance.cleanupPending ? "Cleanup is still unconfirmed; Devbot will not start another preview." : undefined,
    instance.message
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function normalizeLedgerEntry(value: unknown): PreviewLedgerEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Partial<PreviewLedgerEntry>;
  if (
    typeof entry.id !== "string" ||
    !isPreviewId(entry.id) ||
    typeof entry.taskId !== "string" ||
    typeof entry.projectName !== "string" ||
    typeof entry.workspacePath !== "string" ||
    typeof entry.command !== "string" ||
    typeof entry.marker !== "string" ||
    typeof entry.port !== "number" ||
    !Number.isInteger(entry.port) ||
    entry.port <= 0 ||
    entry.port > 65_535 ||
    typeof entry.origin !== "string"
  ) {
    return undefined;
  }
  const pid = typeof entry.pid === "number" && Number.isSafeInteger(entry.pid) && entry.pid > 0 ? entry.pid : undefined;
  const parsedChildIdentity = normalizePreviewChildIdentity(entry.childIdentity);
  const childIdentity = parsedChildIdentity && parsedChildIdentity.pid === pid ? parsedChildIdentity : undefined;
  const tempHome = typeof entry.tempHome === "string" && isManagedTempHome(entry.tempHome) ? path.resolve(entry.tempHome) : undefined;
  return {
    id: entry.id,
    taskId: entry.taskId,
    projectName: entry.projectName,
    workspacePath: entry.workspacePath,
    command: entry.command,
    marker: entry.marker,
    port: entry.port,
    origin: entry.origin,
    ...(pid !== undefined ? { pid } : {}),
    ...(childIdentity ? { childIdentity } : {}),
    ...(tempHome ? { tempHome } : {}),
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
    expiresAt: typeof entry.expiresAt === "string" ? entry.expiresAt : new Date(0).toISOString()
  };
}

function previewMarker(id: string): string {
  return `devbot-preview-${id}`;
}

function normalizePreviewChildIdentity(value: unknown): ExecutionChildIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = value as Partial<ExecutionChildIdentity>;
  if (
    typeof child.pid !== "number" ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 0 ||
    typeof child.groupId !== "number" ||
    !Number.isSafeInteger(child.groupId) ||
    child.groupId !== child.pid ||
    typeof child.startedAt !== "string" ||
    !child.startedAt.trim() ||
    typeof child.command !== "string" ||
    !child.command.trim()
  ) {
    return undefined;
  }
  return {
    pid: child.pid,
    groupId: child.groupId,
    startedAt: child.startedAt.trim(),
    command: child.command.trim()
  };
}

function isManagedTempHome(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const tempRoot = path.resolve(tmpdir());
  const relative = path.relative(tempRoot, resolved);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    path.basename(resolved).startsWith("devbot-preview-home-")
  );
}

function assertManagedTempHome(candidate: string): void {
  if (!isManagedTempHome(candidate)) {
    throw new Error(`Refusing to remove a preview home outside the managed temp namespace: ${candidate}`);
  }
}

function newPreviewId(): string {
  return `prv-${randomBytes(6).toString("hex")}`;
}

function cloneInstance(instance: PreviewInstance): PreviewInstance {
  return { ...instance, command: { ...instance.command } };
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to reserve a loopback port.")));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function respondsOnLoopback(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: "GET", redirect: "manual", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function signalPreviewProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // A detached preview is its process-group leader. Never fall back to the
    // positive pid after a failed group signal: the group may have vanished
    // and that numeric pid may already belong to an unrelated process.
  }
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Classifies who owns the loopback listener on `port` relative to the managed
 * child's process group. Returns "owned" when a listening pid shares the child's
 * process group (the managed child or a descendant), "foreign" when every
 * listening pid belongs to a different group, and "unknown" when ownership
 * cannot be determined yet (no listener bound, or the tooling is unavailable).
 * "unknown" never proves ownership, so callers keep waiting or fail closed.
 */
async function classifyPortListener(port: number, groupId: number | undefined): Promise<PortOwnership> {
  if (process.platform === "win32" || groupId === undefined) {
    return "unknown";
  }
  const managedSockets = await listeningSocketsForProcessGroup(groupId);
  if (managedSockets?.some((socket) => !isLoopbackListener(socket.name))) {
    return "unsafe";
  }
  const sockets = await listeningSocketsOnPort(port);
  if (sockets === undefined || sockets.length === 0) {
    return "unknown";
  }
  const byPid = new Map<number, ListeningSocket[]>();
  for (const socket of sockets) {
    byPid.set(socket.pid, [...(byPid.get(socket.pid) ?? []), socket]);
  }
  let sawOwned = false;
  let sawForeign = false;
  let sawUnknown = false;
  for (const [pid, pidSockets] of byPid) {
    const pgid = await processGroupId(pid);
    if (pgid === groupId) {
      sawOwned = true;
      if (pidSockets.some((socket) => !isLoopbackListenerName(socket.name, port))) {
        return "unsafe";
      }
      continue;
    }
    if (pgid !== undefined) {
      sawForeign = true;
    } else {
      sawUnknown = true;
    }
  }
  if (sawOwned && !sawForeign && !sawUnknown) return "owned";
  return sawForeign ? "foreign" : "unknown";
}

async function listeningSocketsOnPort(port: number): Promise<ListeningSocket[] | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], {
      env: minimalChildEnvironment(),
      maxBuffer: 1_000_000,
      timeout: 5_000
    });
    return parseListeningSockets(stdout);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    if (failure.code === "ENOENT") {
      // lsof is unavailable; ownership cannot be determined.
      return undefined;
    }
    // lsof exits non-zero with empty output when nothing matches the filter.
    return parseListeningSockets(failure.stdout ?? "");
  }
}

async function listeningSocketsForProcessGroup(groupId: number): Promise<ListeningSocket[] | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-a", "-g", String(groupId), "-iTCP", "-sTCP:LISTEN", "-Fpn"],
      { env: minimalChildEnvironment(), maxBuffer: 1_000_000, timeout: 5_000 }
    );
    return parseListeningSockets(stdout);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    if (failure.code === "ENOENT") return undefined;
    return parseListeningSockets(failure.stdout ?? "");
  }
}

function parseListeningSockets(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  let pid: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    } else if (line.startsWith("n") && pid !== undefined && line.length > 1) {
      sockets.push({ pid, name: line.slice(1) });
    }
  }
  return sockets;
}

function isLoopbackListenerName(name: string, port: number): boolean {
  return isLoopbackListener(name) && (name.endsWith(`:${port}`));
}

function isLoopbackListener(name: string): boolean {
  return /^127\.0\.0\.1:\d+$/.test(name) || /^\[::1\]:\d+$/.test(name);
}

async function processGroupId(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)], {
      env: minimalChildEnvironment(),
      maxBuffer: 100_000,
      timeout: 5_000
    });
    const pgid = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

async function capturePreviewIdentity(pid: number, pollIntervalMs: number): Promise<ExecutionChildIdentity | undefined> {
  const deadline = Date.now() + 2_000;
  do {
    const identity = await captureChildIdentity(pid);
    if (identity) return identity;
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);
  return undefined;
}

async function readPackageScripts(workspacePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return undefined;
    return scripts as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function directoryExists(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function withOutputTail(message: string, outputTail: string): string {
  const tail = redactSensitiveText(outputTail.trim());
  return tail ? `${message}\nRecent output:\n${tail.slice(-600)}` : message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
