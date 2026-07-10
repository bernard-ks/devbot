import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { hardenedGitArguments, hardenedGitEnvironment } from "./security.js";

const DEFAULT_BRANCH_PREFIX = "devbot/task";
const DEFAULT_DIFF_LIMIT = 100_000;
const DEFAULT_MAX_WORKTREES = 100;

export type TaskWorktreeUnavailableReason =
  | "not_a_git_repository"
  | "invalid_task_name"
  | "invalid_base_ref"
  | "unsafe_worktree_path"
  | "worktree_path_exists"
  | "branch_exists"
  | "unsafe_git_config"
  | "worktree_limit_reached"
  | "git_worktree_unavailable"
  | "not_an_isolated_worktree";

export interface TaskWorktreeUnavailable {
  available: false;
  reason: TaskWorktreeUnavailableReason;
  message: string;
}

export interface TaskWorktree {
  sourcePath: string;
  path: string;
  branch: string;
  baseRevision: string;
}

export interface TaskWorktreeReady {
  available: true;
  worktree: TaskWorktree;
}

export type CreateTaskWorktreeResult = TaskWorktreeReady | TaskWorktreeUnavailable;

export interface CreateTaskWorktreeOptions {
  sourcePath: string;
  taskName: string;
  baseRef?: string;
  worktreeRoot?: string;
  branchPrefix?: string;
  maxWorktrees?: number;
}

export interface TaskWorktreeChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: "tracked" | "untracked";
  previousPath?: string;
}

export interface DiffEvidence {
  staged: string;
  unstaged: string;
  truncated: boolean;
}

export interface TaskWorktreeInspection {
  available: true;
  worktree: TaskWorktree;
  headRevision: string;
  changes: TaskWorktreeChange[];
  diff: DiffEvidence;
}

export type InspectTaskWorktreeResult = TaskWorktreeInspection | TaskWorktreeUnavailable;

export interface CommitTaskWorktreeOptions {
  message: string;
  files: readonly string[];
}

export interface TaskWorktreeCommitResult {
  available: true;
  committed: boolean;
  worktree: TaskWorktree;
  revision?: string;
  changes: TaskWorktreeChange[];
  message?: string;
}

export type CommitTaskWorktreeResult = TaskWorktreeCommitResult | TaskWorktreeUnavailable;

interface GitOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Converts a task label into a predictable, filesystem-safe worktree segment. */
export function sanitizeTaskWorktreeName(value: string): string | undefined {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return sanitized || undefined;
}

export function defaultTaskWorktreeRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.DEVBOT_WORKTREE_ROOT?.trim();
  return path.resolve(configured || path.join(homedir(), ".devbot", "worktrees"));
}

/**
 * Creates a new branch in a separate worktree. It never checks out, stages, or
 * otherwise mutates files in the source checkout.
 */
export async function createTaskWorktree(options: CreateTaskWorktreeOptions): Promise<CreateTaskWorktreeResult> {
  const sourcePath = path.resolve(options.sourcePath);
  const sourceRoot = await gitPath(sourcePath, ["rev-parse", "--show-toplevel"]);
  if (!sourceRoot.ok) {
    return unavailable("not_a_git_repository", `Cannot isolate this task because ${sourcePath} is not a Git repository.`);
  }

  const taskName = sanitizeTaskWorktreeName(options.taskName);
  const branchPrefix = sanitizeBranchPrefix(options.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  if (!taskName || !branchPrefix) {
    return unavailable("invalid_task_name", "Task and branch names must contain letters or numbers.");
  }

  const repositoryPath = path.resolve(sourceRoot.stdout.trim());
  const unsafeConfig = await configuredGitExecutionHelpers(repositoryPath);
  if (unsafeConfig === undefined) {
    return unavailable("git_worktree_unavailable", "Cannot inspect the repository's local Git configuration safely.");
  }
  if (unsafeConfig.length > 0) {
    return unavailable(
      "unsafe_git_config",
      "Branch isolation is blocked because the repository config defines a clean, smudge, or process filter that Git could execute during checkout."
    );
  }
  const worktreeRoot = path.resolve(options.worktreeRoot ?? defaultTaskWorktreeRoot());
  let worktreePath = path.join(worktreeRoot, taskName);
  if (isWithin(worktreePath, repositoryPath)) {
    return unavailable("unsafe_worktree_path", "The worktree root must not place an isolated checkout inside the source checkout.");
  }

  const baseRef = options.baseRef?.trim() || "HEAD";
  const baseRevision = await gitPath(repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
  if (!baseRevision.ok) {
    return unavailable("invalid_base_ref", `Cannot resolve the requested base revision: ${baseRef}.`);
  }

  const branch = `${branchPrefix}/${taskName}`;
  const branchExists = await gitPath(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchExists.ok) {
    return unavailable("branch_exists", `The isolated branch ${branch} already exists; it was left untouched.`);
  }

  try {
    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(worktreeRoot, 0o700);
    worktreePath = path.join(await realpath(worktreeRoot), taskName);
  } catch (error) {
    return unavailable("git_worktree_unavailable", `Cannot create the worktree root: ${(error as Error).message}`);
  }
  if (isWithin(worktreePath, repositoryPath)) {
    return unavailable("unsafe_worktree_path", "The worktree root resolves inside the source checkout.");
  }
  let worktreePathExists: boolean;
  try {
    worktreePathExists = await fileExists(worktreePath);
  } catch (error) {
    return unavailable("git_worktree_unavailable", `Cannot inspect the worktree path: ${(error as Error).message}`);
  }
  if (worktreePathExists) {
    return unavailable("worktree_path_exists", `The worktree path ${worktreePath} already exists; it was left untouched.`);
  }
  const maxWorktrees = Math.max(1, Math.floor(options.maxWorktrees ?? DEFAULT_MAX_WORKTREES));
  try {
    const existingWorktrees = (await readdir(worktreeRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
    if (existingWorktrees >= maxWorktrees) {
      return unavailable(
        "worktree_limit_reached",
        `The isolated worktree limit (${maxWorktrees}) has been reached. Review and remove old Devbot worktrees before starting another action.`
      );
    }
  } catch (error) {
    return unavailable("git_worktree_unavailable", `Cannot inspect the worktree root: ${(error as Error).message}`);
  }

  const pathExists = await gitPath(repositoryPath, ["worktree", "list", "--porcelain"]);
  if (!pathExists.ok) {
    return unavailable("git_worktree_unavailable", errorMessage("Git worktree support is unavailable", pathExists));
  }
  if (pathExists.stdout.split("\n").some((line) => line === `worktree ${worktreePath}`)) {
    return unavailable("worktree_path_exists", `The worktree path ${worktreePath} already exists; it was left untouched.`);
  }

  const created = await gitPath(repositoryPath, ["worktree", "add", "-b", branch, worktreePath, baseRevision.stdout.trim()]);
  if (!created.ok) {
    return unavailable("git_worktree_unavailable", errorMessage("Unable to create an isolated Git worktree", created));
  }

  return {
    available: true,
    worktree: {
      sourcePath: repositoryPath,
      path: worktreePath,
      branch,
      baseRevision: baseRevision.stdout.trim()
    }
  };
}

/** Returns Git status and bounded staged/unstaged patch evidence for one isolated worktree. */
export async function inspectTaskWorktree(
  worktree: TaskWorktree,
  diffLimit = DEFAULT_DIFF_LIMIT
): Promise<InspectTaskWorktreeResult> {
  const verified = await verifyIsolatedWorktree(worktree);
  if (!verified.available) {
    return verified;
  }

  const [status, head, staged, unstaged] = await Promise.all([
    gitPath(worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]),
    gitPath(worktree.path, ["rev-parse", "HEAD"]),
    gitPath(worktree.path, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-color", "--binary"]),
    gitPath(worktree.path, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-color", "--binary"])
  ]);
  if (!status.ok || !head.ok || !staged.ok || !unstaged.ok) {
    const failed = [status, head, staged, unstaged].find((result) => !result.ok);
    return unavailable("not_an_isolated_worktree", errorMessage("Unable to inspect the isolated worktree", failed));
  }

  const limit = Math.max(0, Math.floor(diffLimit));
  const combined = `${staged.stdout}${unstaged.stdout}`;
  const truncated = combined.length > limit;
  const stagedEvidence = truncate(staged.stdout, limit);
  const remaining = Math.max(0, limit - stagedEvidence.length);

  return {
    available: true,
    worktree,
    headRevision: head.stdout.trim(),
    changes: parsePorcelainStatus(status.stdout),
    diff: {
      staged: stagedEvidence,
      unstaged: truncate(unstaged.stdout, remaining),
      truncated
    }
  };
}

/** Stages only reported changes in the isolated worktree and creates one commit when there is work to commit. */
export async function commitTaskWorktree(
  worktree: TaskWorktree,
  options: CommitTaskWorktreeOptions
): Promise<CommitTaskWorktreeResult> {
  const inspection = await inspectTaskWorktree(worktree, 0);
  if (!inspection.available) {
    return inspection;
  }
  if (!options.message.trim()) {
    return {
      available: true,
      committed: false,
      worktree,
      changes: inspection.changes,
      message: "A non-empty commit message is required."
    };
  }

  const changedPaths = new Set(inspection.changes.map((change) => change.path));
  const files = [...options.files];
  const invalidFile = files.find((file) => !isSafeChangedPath(file, worktree.path, changedPaths));
  if (invalidFile) {
    return {
      available: true,
      committed: false,
      worktree,
      changes: inspection.changes,
      message: `Refusing to stage ${invalidFile}; commit paths must be changed files within the isolated worktree.`
    };
  }
  if (files.length === 0) {
    return {
      available: true,
      committed: false,
      worktree,
      changes: inspection.changes,
      message: "There are no task changes to commit."
    };
  }

  const staged = await gitPath(worktree.path, ["add", "--", ...files]);
  if (!staged.ok) {
    return {
      available: true,
      committed: false,
      worktree,
      changes: inspection.changes,
      message: errorMessage("Unable to stage task changes", staged)
    };
  }

  const commit = await gitPath(worktree.path, ["commit", "-m", options.message]);
  if (!commit.ok) {
    return {
      available: true,
      committed: false,
      worktree,
      changes: inspection.changes,
      message: errorMessage("Unable to commit task changes", commit)
    };
  }

  const revision = await gitPath(worktree.path, ["rev-parse", "HEAD"]);
  return {
    available: true,
    committed: true,
    worktree,
    ...(revision.ok ? { revision: revision.stdout.trim() } : {}),
    changes: inspection.changes
  };
}

function sanitizeBranchPrefix(value: string): string | undefined {
  const segments = value.split("/").map(sanitizeTaskWorktreeName);
  return segments.every((segment): segment is string => Boolean(segment)) ? segments.join("/") : undefined;
}

async function verifyIsolatedWorktree(worktree: TaskWorktree): Promise<{ available: true } | TaskWorktreeUnavailable> {
  if (path.resolve(worktree.path) === path.resolve(worktree.sourcePath)) {
    return unavailable("not_an_isolated_worktree", "The source checkout cannot be used as a task worktree.");
  }

  const [root, branch, registered] = await Promise.all([
    gitPath(worktree.path, ["rev-parse", "--show-toplevel"]),
    gitPath(worktree.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitPath(worktree.sourcePath, ["worktree", "list", "--porcelain"])
  ]);
  const expectedPath = path.resolve(worktree.path);
  const expectedBranch = `refs/heads/${worktree.branch}`;
  const registeredHere = registered.ok && registered.stdout.split(/\n\n+/).some((block) => {
    const lines = block.split("\n");
    return lines.includes(`worktree ${expectedPath}`) && lines.includes(`branch ${expectedBranch}`);
  });
  if (
    !root.ok ||
    !branch.ok ||
    path.resolve(root.stdout.trim()) !== expectedPath ||
    branch.stdout.trim() !== worktree.branch ||
    !registeredHere
  ) {
    return unavailable("not_an_isolated_worktree", "The requested path is not the expected isolated task worktree.");
  }
  return { available: true };
}

export function parsePorcelainStatus(output: string): TaskWorktreeChange[] {
  const fields = output.split("\0");
  const changes: TaskWorktreeChange[] = [];
  for (let index = 0; index < fields.length - 1; index += 1) {
    const entry = fields[index];
    if (!entry || entry.length < 3) continue;
    const indexStatus = entry[0] ?? " ";
    const worktreeStatus = entry[1] ?? " ";
    const filePath = entry.slice(3);
    const renamed = /[RC]/.test(`${indexStatus}${worktreeStatus}`);
    const previousPath = renamed ? fields[++index] : undefined;
    changes.push({
      path: filePath,
      indexStatus,
      worktreeStatus,
      kind: indexStatus === "?" && worktreeStatus === "?" ? "untracked" : "tracked",
      ...(previousPath ? { previousPath } : {})
    });
  }
  return changes;
}

function isSafeChangedPath(file: string, worktreePath: string, changedPaths: ReadonlySet<string>): boolean {
  if (!file || file.includes("\0") || path.isAbsolute(file) || !changedPaths.has(file)) {
    return false;
  }
  const resolved = path.resolve(worktreePath, file);
  return isWithin(resolved, worktreePath);
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function unavailable(reason: TaskWorktreeUnavailableReason, message: string): TaskWorktreeUnavailable {
  return { available: false, reason, message };
}

function errorMessage(prefix: string, result: GitOutput | undefined): string {
  const detail = result ? (result.stderr || result.stdout).trim() : "Unknown Git failure.";
  return detail ? `${prefix}: ${detail}` : prefix;
}

async function configuredGitExecutionHelpers(repositoryPath: string): Promise<string[] | undefined> {
  const result = await gitPath(repositoryPath, ["config", "--local", "--name-only", "--null", "--list"]);
  if (!result.ok) return undefined;
  return result.stdout
    .split("\0")
    .map((key) => key.trim())
    .filter((key) => /^filter\..*\.(?:clean|smudge|process)$/i.test(key));
}

function gitPath(cwd: string, args: string[]): Promise<GitOutput> {
  return new Promise((resolve) => {
    execFile(
      "git",
      hardenedGitArguments(cwd, args),
      {
        encoding: "utf8",
        env: hardenedGitEnvironment(),
        maxBuffer: 2_000_000,
        timeout: 30_000,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout, stderr });
      }
    );
  });
}
