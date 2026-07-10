import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hardenedGitArguments, hardenedGitEnvironment } from "./security.js";

const execFileAsync = promisify(execFile);

const CHECKPOINT_NAMESPACE = "refs/devbot/checkpoints";
const DEFAULT_KEEP = 20;

export interface CheckpointMeta {
  ref: string;
  commit: string;
  tree: string;
  headSha: string;
  branch: string;
  createdAt: string;
}

export type CheckpointChangeStatus = "added" | "modified" | "deleted";

export interface CheckpointChange {
  status: CheckpointChangeStatus;
  path: string;
}

export interface RestoreOptions {
  expectedHeadSha?: string;
  expectedBranch?: string;
  expectedPostTaskTree?: string;
}

export interface RestoreSummary {
  restored: string[];
  deleted: string[];
  changes: CheckpointChange[];
}

export type RollbackRefusalReason = "head-moved" | "branch-moved" | "workspace-changed";

export class RollbackRefusedError extends Error {
  readonly reason: RollbackRefusalReason;
  readonly details: string[];

  constructor(reason: RollbackRefusalReason, message: string, details: string[] = []) {
    super(message);
    this.name = "RollbackRefusedError";
    this.reason = reason;
    this.details = details;
  }
}

export function checkpointRefFor(taskId: string): string {
  if (!/^task-[a-z0-9-]{1,64}$/i.test(taskId)) {
    throw new Error("Checkpoint ref requires a valid task ID.");
  }
  return `${CHECKPOINT_NAMESPACE}/${taskId}`;
}

/** Computes the exact working-tree hash (tracked, staged, and untracked content) without touching the real index. */
export async function hashWorkingTree(repoPath: string): Promise<string> {
  return snapshotWorkingTree(repoPath);
}

export async function createCheckpoint(repoPath: string, taskId: string): Promise<CheckpointMeta> {
  const ref = checkpointRefFor(taskId);
  const tree = await snapshotWorkingTree(repoPath);
  const headSha = await resolveHead(repoPath);
  const branch = await resolveBranch(repoPath);
  const commitArgs = ["commit-tree", tree, "-m", `devbot checkpoint ${taskId}`];
  if (headSha) {
    commitArgs.push("-p", headSha);
  }
  const commit = (await runGit(repoPath, commitArgs)).trim();
  await runGit(repoPath, ["update-ref", ref, commit]);
  return {
    ref,
    commit,
    tree,
    headSha: headSha ?? "",
    branch,
    createdAt: new Date().toISOString()
  };
}

export async function diffSinceCheckpoint(repoPath: string, ref: string): Promise<CheckpointChange[]> {
  const currentTree = await snapshotWorkingTree(repoPath);
  return diffTrees(repoPath, ref, currentTree);
}

export async function restoreCheckpoint(
  repoPath: string,
  ref: string,
  options: RestoreOptions = {}
): Promise<RestoreSummary> {
  const headSha = (await resolveHead(repoPath)) ?? "";
  const branch = await resolveBranch(repoPath);

  if (options.expectedHeadSha !== undefined && headSha !== options.expectedHeadSha) {
    throw new RollbackRefusedError(
      "head-moved",
      "HEAD moved since the checkpoint was taken (new commits or a reset). Undo needs a human to reconcile."
    );
  }
  if (options.expectedBranch !== undefined && branch !== options.expectedBranch) {
    throw new RollbackRefusedError(
      "branch-moved",
      `The branch changed from \`${options.expectedBranch}\` to \`${branch}\` since the checkpoint. Undo needs a human to reconcile.`
    );
  }

  const currentTree = await snapshotWorkingTree(repoPath);

  if (options.expectedPostTaskTree !== undefined && currentTree !== options.expectedPostTaskTree) {
    const driftedPaths = (await diffTrees(repoPath, options.expectedPostTaskTree, currentTree)).map((change) => change.path);
    throw new RollbackRefusedError(
      "workspace-changed",
      "The workspace no longer matches its state right after this task finished (a file was edited, added, or deleted since). Undo would clobber that work, so manual review is needed.",
      driftedPaths
    );
  }

  const changes = await diffTrees(repoPath, ref, currentTree);

  const restorePaths = changes.filter((change) => change.status !== "added").map((change) => change.path);
  const deletePaths = changes.filter((change) => change.status === "added").map((change) => change.path);

  if (restorePaths.length > 0) {
    await runGit(repoPath, ["checkout", ref, "--", ...restorePaths]);
  }
  for (const relativePath of deletePaths) {
    await rm(path.join(repoPath, relativePath), { force: true });
  }
  if (deletePaths.length > 0) {
    await runGit(repoPath, ["reset", "-q", "--", ...deletePaths]).catch(() => undefined);
  }

  return { restored: restorePaths, deleted: deletePaths, changes };
}

export async function pruneCheckpoints(repoPath: string, keep = DEFAULT_KEEP): Promise<string[]> {
  const limit = Math.max(0, keep);
  const raw = await runGit(repoPath, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)",
    CHECKPOINT_NAMESPACE
  ]);
  const refs = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const stale = refs.slice(limit);
  for (const ref of stale) {
    await runGit(repoPath, ["update-ref", "-d", ref]).catch(() => undefined);
  }
  return stale;
}

export function formatCheckpointChanges(changes: CheckpointChange[]): string {
  if (changes.length === 0) {
    return "(no changes since the checkpoint — nothing to undo)";
  }
  return changes
    .map((change) => `${changeGlyph(change.status)} ${change.path}`)
    .join("\n");
}

async function snapshotWorkingTree(repoPath: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "devbot-checkpoint-"));
  const indexFile = path.join(dir, "index");
  try {
    await runGit(repoPath, ["add", "-A"], indexFile);
    return (await runGit(repoPath, ["write-tree"], indexFile)).trim();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function resolveHead(repoPath: string): Promise<string | undefined> {
  try {
    return (await runGit(repoPath, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    return undefined;
  }
}

async function resolveBranch(repoPath: string): Promise<string> {
  try {
    const branch = (await runGit(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"])).trim();
    if (branch) {
      return branch;
    }
  } catch {
    // Detached HEAD has no symbolic ref.
  }
  return "HEAD";
}

async function diffTrees(repoPath: string, fromTree: string, toTree: string): Promise<CheckpointChange[]> {
  const raw = await runGit(repoPath, ["diff", "--name-status", "--no-renames", "-z", fromTree, toTree]);
  return parseNameStatus(raw);
}

function parseNameStatus(raw: string): CheckpointChange[] {
  const fields = raw.split("\0").filter((field) => field.length > 0);
  const changes: CheckpointChange[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = mapStatus(fields[index] ?? "");
    const filePath = fields[index + 1] ?? "";
    if (status && filePath) {
      changes.push({ status, path: filePath });
    }
  }
  return changes;
}

function mapStatus(code: string): CheckpointChangeStatus | undefined {
  const letter = code.charAt(0).toUpperCase();
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "M" || letter === "T") return "modified";
  return undefined;
}

function changeGlyph(status: CheckpointChangeStatus): string {
  if (status === "added") return "removed (created during task)";
  if (status === "deleted") return "restored (deleted during task)";
  return "reverted";
}

async function runGit(repoPath: string, args: string[], indexFile?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...hardenedGitEnvironment(),
    GIT_AUTHOR_NAME: "devbot",
    GIT_AUTHOR_EMAIL: "devbot@localhost",
    GIT_COMMITTER_NAME: "devbot",
    GIT_COMMITTER_EMAIL: "devbot@localhost"
  };
  if (indexFile) {
    env.GIT_INDEX_FILE = indexFile;
  }
  const { stdout } = await execFileAsync("git", hardenedGitArguments(repoPath, args), {
    env,
    timeout: 30_000,
    maxBuffer: 32_000_000
  });
  return stdout;
}
