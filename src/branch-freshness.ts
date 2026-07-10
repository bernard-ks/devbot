import { execFile } from "node:child_process";
import { hardenedGitArguments, hardenedGitEnvironment, redactSensitiveText } from "./security.js";
import { inspectTaskWorktree } from "./task-worktree.js";
import type { TaskWorktree } from "./task-worktree.js";
import { isTaskId } from "./task-store.js";

const BACKUP_REF_PREFIX = "refs/devbot/backup/";
const BACKUP_REF_PATTERN = /^refs\/devbot\/backup\/task-[a-z0-9-]{1,52}$/;
const MAX_REPORTED_CONFLICT_FILES = 15;
const REBASE_TIMEOUT_MS = 120_000;

export type BranchFreshnessUnavailableReason =
  | "invalid_branch_name"
  | "invalid_default_branch"
  | "branch_missing"
  | "default_branch_missing"
  | "git_unavailable";

export interface BranchFreshnessUnavailable {
  available: false;
  reason: BranchFreshnessUnavailableReason;
  message: string;
}

export interface BranchFreshness {
  available: true;
  branch: string;
  defaultBranch: string;
  branchTip: string;
  defaultTip: string;
  merged: boolean;
  behind: number;
  ahead: number;
}

export type BranchFreshnessResult = BranchFreshness | BranchFreshnessUnavailable;

export interface InspectBranchFreshnessOptions {
  repositoryPath: string;
  branch: string;
  defaultBranch: string;
}

export type SyncTaskBranchBlockedReason =
  | "invalid_task_id"
  | "not_an_isolated_worktree"
  | "dirty_worktree"
  | "backup_failed"
  | "sync_failed"
  | BranchFreshnessUnavailableReason;

export interface SyncTaskBranchBlocked {
  ok: false;
  outcome: "blocked";
  reason: SyncTaskBranchBlockedReason;
  message: string;
}

export interface SyncTaskBranchAlreadyMerged {
  ok: true;
  outcome: "already-merged";
  freshness: BranchFreshness;
}

export interface SyncTaskBranchUpToDate {
  ok: true;
  outcome: "up-to-date";
  freshness: BranchFreshness;
}

export interface SyncTaskBranchSynced {
  ok: true;
  outcome: "synced";
  branch: string;
  defaultBranch: string;
  defaultTip: string;
  previousTip: string;
  newTip: string;
  backupRef: string;
  replayedCommits: number;
}

export interface SyncTaskBranchConflict {
  ok: false;
  outcome: "conflict";
  branch: string;
  defaultBranch: string;
  previousTip: string;
  backupRef: string;
  restored: boolean;
  conflictedFiles: string[];
  conflictedFileCount: number;
  message: string;
}

export type SyncTaskBranchResult =
  | SyncTaskBranchBlocked
  | SyncTaskBranchAlreadyMerged
  | SyncTaskBranchUpToDate
  | SyncTaskBranchSynced
  | SyncTaskBranchConflict;

export interface SyncTaskBranchOptions {
  worktree: TaskWorktree;
  defaultBranch: string;
  taskId: string;
}

interface GitOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Accepts only plain branch names Devbot itself would create or configure; rejects revision syntax. */
export function isSafeBranchName(value: string): boolean {
  if (!value || value.length > 200 || value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && !segment.startsWith(".") && !segment.startsWith("-") && !segment.endsWith(".lock") && !segment.includes(".."));
}

/** Returns the exact-format backup ref for one task, or undefined when the task ID cannot form a safe ref. */
export function backupRefForTask(taskId: string): string | undefined {
  if (!isTaskId(taskId)) {
    return undefined;
  }
  const ref = `${BACKUP_REF_PREFIX}${taskId}`;
  return BACKUP_REF_PATTERN.test(ref) ? ref : undefined;
}

/** Compares one local task branch against the project's local default branch, read-only. */
export async function inspectBranchFreshness(options: InspectBranchFreshnessOptions): Promise<BranchFreshnessResult> {
  if (!isSafeBranchName(options.branch)) {
    return unavailable("invalid_branch_name", `The saved branch name cannot be inspected safely: ${redactSensitiveText(options.branch)}`);
  }
  if (!isSafeBranchName(options.defaultBranch)) {
    return unavailable("invalid_default_branch", `The configured default branch name cannot be inspected safely: ${redactSensitiveText(options.defaultBranch)}`);
  }

  const branchTip = await git(options.repositoryPath, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${options.branch}^{commit}`]);
  if (!branchTip.ok) {
    return unavailable("branch_missing", `The task branch ${options.branch} no longer exists locally.`);
  }
  const defaultTip = await git(options.repositoryPath, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${options.defaultBranch}^{commit}`]);
  if (!defaultTip.ok) {
    return unavailable("default_branch_missing", `The default branch ${options.defaultBranch} does not exist locally.`);
  }

  const merged = await git(options.repositoryPath, ["merge-base", "--is-ancestor", branchTip.stdout.trim(), defaultTip.stdout.trim()]);
  if (!merged.ok && merged.stderr.trim()) {
    return unavailable("git_unavailable", errorMessage("Unable to compare the task branch with the default branch", merged));
  }
  const counts = await git(options.repositoryPath, [
    "rev-list",
    "--left-right",
    "--count",
    `${defaultTip.stdout.trim()}...${branchTip.stdout.trim()}`
  ]);
  const parsed = counts.ok ? counts.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
  if (!parsed) {
    return unavailable("git_unavailable", errorMessage("Unable to count branch divergence", counts));
  }

  return {
    available: true,
    branch: options.branch,
    defaultBranch: options.defaultBranch,
    branchTip: branchTip.stdout.trim(),
    defaultTip: defaultTip.stdout.trim(),
    merged: merged.ok,
    behind: Number(parsed[1]),
    ahead: Number(parsed[2])
  };
}

export function describeBranchFreshness(freshness: BranchFreshness): string {
  if (freshness.merged) {
    return `merged into ${freshness.defaultBranch}; the isolated worktree is eligible for pruning`;
  }
  if (freshness.behind === 0) {
    return `up to date with ${freshness.defaultBranch}${freshness.ahead > 0 ? `, ahead by ${freshness.ahead}` : ""}`;
  }
  return `behind ${freshness.defaultBranch} by ${freshness.behind}, ahead by ${freshness.ahead}`;
}

/**
 * Rebases one isolated task branch onto the local default branch tip. The
 * rebase runs only inside the verified isolated worktree, the pre-sync tip is
 * preserved under an exact-format backup ref first, and conflicts abort with
 * the branch restored rather than being auto-resolved.
 */
export async function syncTaskBranch(options: SyncTaskBranchOptions): Promise<SyncTaskBranchResult> {
  const backupRef = backupRefForTask(options.taskId);
  if (!backupRef) {
    return blocked("invalid_task_id", `The task ID cannot form a safe backup ref: ${redactSensitiveText(options.taskId)}`);
  }

  const inspection = await inspectTaskWorktree(options.worktree, 0);
  if (!inspection.available) {
    return blocked("not_an_isolated_worktree", inspection.message);
  }
  if (inspection.changes.length > 0) {
    return blocked(
      "dirty_worktree",
      `The isolated worktree has ${inspection.changes.length} uncommitted ${inspection.changes.length === 1 ? "change" : "changes"}; commit or review them before syncing.`
    );
  }

  const freshness = await inspectBranchFreshness({
    repositoryPath: options.worktree.sourcePath,
    branch: options.worktree.branch,
    defaultBranch: options.defaultBranch
  });
  if (!freshness.available) {
    return blocked(freshness.reason, freshness.message);
  }
  if (freshness.merged) {
    return { ok: true, outcome: "already-merged", freshness };
  }
  if (freshness.behind === 0) {
    return { ok: true, outcome: "up-to-date", freshness };
  }

  const previousTip = freshness.branchTip;
  const preserved = await git(options.worktree.sourcePath, ["update-ref", backupRef, previousTip]);
  const preservedTip = preserved.ok
    ? await git(options.worktree.sourcePath, ["rev-parse", "--verify", "--end-of-options", backupRef])
    : preserved;
  if (!preservedTip.ok || preservedTip.stdout.trim() !== previousTip) {
    return blocked("backup_failed", errorMessage(`Unable to preserve the branch tip under ${backupRef}; the branch was left untouched`, preserved));
  }

  const rebase = await git(options.worktree.path, ["rebase", "--no-autostash", "--empty=drop", freshness.defaultTip], REBASE_TIMEOUT_MS);
  if (!rebase.ok) {
    return abortAndRestore(options.worktree, freshness, previousTip, backupRef, rebase);
  }

  const verified = await inspectTaskWorktree(options.worktree, 0);
  const newTip = await git(options.worktree.path, ["rev-parse", "HEAD"]);
  const rebased = newTip.ok
    ? await git(options.worktree.sourcePath, ["merge-base", "--is-ancestor", freshness.defaultTip, newTip.stdout.trim()])
    : newTip;
  if (!verified.available || verified.changes.length > 0 || !newTip.ok || !rebased.ok) {
    return blocked(
      "sync_failed",
      errorMessage(`The rebase finished but the worktree state could not be verified; the pre-sync tip remains preserved at ${backupRef}`, rebased)
    );
  }

  return {
    ok: true,
    outcome: "synced",
    branch: options.worktree.branch,
    defaultBranch: options.defaultBranch,
    defaultTip: freshness.defaultTip,
    previousTip,
    newTip: newTip.stdout.trim(),
    backupRef,
    replayedCommits: freshness.ahead
  };
}

async function abortAndRestore(
  worktree: TaskWorktree,
  freshness: BranchFreshness,
  previousTip: string,
  backupRef: string,
  rebase: GitOutput
): Promise<SyncTaskBranchBlocked | SyncTaskBranchConflict> {
  const conflicted = await git(worktree.path, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  const conflictedFiles = conflicted.ok
    ? conflicted.stdout.split("\0").map((file) => redactSensitiveText(file)).filter(Boolean)
    : [];
  await git(worktree.path, ["rebase", "--abort"]);

  let tip = await git(worktree.path, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${worktree.branch}^{commit}`]);
  if (!tip.ok || tip.stdout.trim() !== previousTip) {
    await git(worktree.sourcePath, ["update-ref", `refs/heads/${worktree.branch}`, previousTip]);
    await git(worktree.path, ["reset", "--hard", previousTip]);
    tip = await git(worktree.path, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${worktree.branch}^{commit}`]);
  }
  const restored = tip.ok && tip.stdout.trim() === previousTip;

  if (conflictedFiles.length === 0) {
    return blocked(
      "sync_failed",
      errorMessage(
        `The rebase failed without reported conflicts; the branch ${restored ? "was restored to its pre-sync tip" : `could not be verified as restored; its pre-sync tip remains preserved at ${backupRef}`}`,
        rebase
      )
    );
  }

  return {
    ok: false,
    outcome: "conflict",
    branch: worktree.branch,
    defaultBranch: freshness.defaultBranch,
    previousTip,
    backupRef,
    restored,
    conflictedFiles: conflictedFiles.slice(0, MAX_REPORTED_CONFLICT_FILES),
    conflictedFileCount: conflictedFiles.length,
    message: restored
      ? "Rebase conflicts are never auto-resolved; the sync was aborted and the branch restored to its pre-sync tip."
      : `Rebase conflicts are never auto-resolved; the sync was aborted, but the branch could not be verified as restored. Its pre-sync tip remains preserved at ${backupRef}.`
  };
}

function unavailable(reason: BranchFreshnessUnavailableReason, message: string): BranchFreshnessUnavailable {
  return { available: false, reason, message };
}

function blocked(reason: SyncTaskBranchBlockedReason, message: string): SyncTaskBranchBlocked {
  return { ok: false, outcome: "blocked", reason, message };
}

function errorMessage(prefix: string, result: GitOutput | undefined): string {
  const detail = result ? redactSensitiveText((result.stderr || result.stdout).trim()) : "Unknown Git failure.";
  return detail ? `${prefix}: ${detail}` : prefix;
}

function git(cwd: string, args: string[], timeout = 30_000): Promise<GitOutput> {
  return new Promise((resolve) => {
    execFile(
      "git",
      hardenedGitArguments(cwd, args),
      {
        encoding: "utf8",
        env: hardenedGitEnvironment(),
        maxBuffer: 2_000_000,
        timeout,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout, stderr });
      }
    );
  });
}
