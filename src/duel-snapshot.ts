import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isIgnoredProjectPath } from "./context.js";
import { parsePorcelainStatus } from "./task-worktree.js";
import { hardenedGitArguments, hardenedGitEnvironment } from "./security.js";

const execFileAsync = promisify(execFile);

const SNAPSHOT_REF_PREFIX = "refs/devbot/duels/";
const DUEL_ID_PATTERN = /^collab-[a-z0-9]+-[a-z0-9]+$/i;
const OBJECT_HASH_PATTERN = /^[0-9a-f]{40,64}$/;
const MAX_SNAPSHOT_FILE_BYTES = 512_000;
const ADD_BATCH_SIZE = 50;
export const MAX_DUEL_SNAPSHOT_REFS = 100;

export interface DuelSnapshot {
  ref: string;
  commit: string;
  tree: string;
}

export type CaptureDuelSnapshotResult = { ok: true; snapshot: DuelSnapshot } | { ok: false; message: string };

/** Exact-format gate: only well-formed duel conversation IDs may become hidden ref names. */
export function duelSnapshotRef(duelId: string): string | undefined {
  return DUEL_ID_PATTERN.test(duelId) ? `${SNAPSHOT_REF_PREFIX}${duelId}` : undefined;
}

/**
 * Pins the exact reviewed working state as a git commit under a hidden ref, without ever
 * touching the working tree or the real index: a temporary GIT_INDEX_FILE overlay stages the
 * same change set the duel evidence covers (committed history via the HEAD parent, plus staged,
 * unstaged, renamed/deleted, and bounded untracked files), honoring the shared sensitive-path
 * exclusions, then write-tree/commit-tree/update-ref record it.
 */
export async function captureDuelSnapshot(root: string, duelId: string): Promise<CaptureDuelSnapshotResult> {
  const ref = duelSnapshotRef(duelId);
  if (!ref) {
    return { ok: false, message: "The duel ID cannot be encoded as a snapshot ref." };
  }

  const toplevel = await git(root, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    return { ok: false, message: "The project root is not a Git repository." };
  }
  const repoRoot = path.resolve(toplevel.stdout.trim());

  const head = await git(repoRoot, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
  if (!head.ok) {
    return { ok: false, message: "The repository has no commit to snapshot against." };
  }
  const headCommit = head.stdout.trim();

  const status = await git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  if (!status.ok) {
    return { ok: false, message: "The repository status could not be inspected." };
  }

  const stagePaths: string[] = [];
  for (const change of parsePorcelainStatus(status.stdout)) {
    for (const candidate of [change.path, change.previousPath]) {
      if (!candidate || isIgnoredProjectPath(candidate)) {
        continue;
      }
      if (!isWithinRoot(path.resolve(repoRoot, candidate), repoRoot)) {
        continue;
      }
      if (change.kind === "untracked" && candidate === change.path && !(await isBoundedRegularFile(path.resolve(repoRoot, candidate)))) {
        continue;
      }
      stagePaths.push(candidate);
    }
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "devbot-duel-index-"));
  const overlay = { ...hardenedGitEnvironment(), GIT_INDEX_FILE: path.join(scratch, "index") };
  try {
    const seeded = await git(repoRoot, ["read-tree", headCommit], overlay);
    if (!seeded.ok) {
      return { ok: false, message: "The snapshot index could not be seeded from HEAD." };
    }
    for (let start = 0; start < stagePaths.length; start += ADD_BATCH_SIZE) {
      const staged = await git(repoRoot, ["add", "-A", "--", ...stagePaths.slice(start, start + ADD_BATCH_SIZE)], overlay);
      if (!staged.ok) {
        return { ok: false, message: "The reviewed changes could not be staged into the snapshot index." };
      }
    }
    const tree = await git(repoRoot, ["write-tree"], overlay);
    if (!tree.ok || !OBJECT_HASH_PATTERN.test(tree.stdout.trim())) {
      return { ok: false, message: "The snapshot tree could not be written." };
    }
    const commit = await git(repoRoot, ["commit-tree", tree.stdout.trim(), "-p", headCommit, "-m", `Devbot duel snapshot for ${duelId}`], overlay);
    if (!commit.ok || !OBJECT_HASH_PATTERN.test(commit.stdout.trim())) {
      return { ok: false, message: "The snapshot commit could not be created." };
    }
    const updated = await git(repoRoot, ["update-ref", ref, commit.stdout.trim()]);
    if (!updated.ok) {
      return { ok: false, message: "The snapshot ref could not be recorded." };
    }
    return { ok: true, snapshot: { ref, commit: commit.stdout.trim(), tree: tree.stdout.trim() } };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Fails closed: true only when the hidden ref still resolves to the exact recorded commit and tree. */
export async function verifyDuelSnapshot(root: string, snapshot: DuelSnapshot): Promise<boolean> {
  if (
    !snapshot.ref.startsWith(SNAPSHOT_REF_PREFIX) ||
    !DUEL_ID_PATTERN.test(snapshot.ref.slice(SNAPSHOT_REF_PREFIX.length)) ||
    !OBJECT_HASH_PATTERN.test(snapshot.commit) ||
    !OBJECT_HASH_PATTERN.test(snapshot.tree)
  ) {
    return false;
  }
  const commit = await git(root, ["rev-parse", "--verify", "--end-of-options", `${snapshot.ref}^{commit}`]);
  if (!commit.ok || commit.stdout.trim() !== snapshot.commit) {
    return false;
  }
  const tree = await git(root, ["rev-parse", "--verify", "--end-of-options", `${snapshot.ref}^{tree}`]);
  return tree.ok && tree.stdout.trim() === snapshot.tree;
}

export async function deleteDuelSnapshotRef(root: string, duelId: string): Promise<boolean> {
  const ref = duelSnapshotRef(duelId);
  if (!ref) {
    return false;
  }
  const deleted = await git(root, ["update-ref", "-d", ref]);
  return deleted.ok;
}

/**
 * Retention: deletes every hidden duel ref whose ID is not in the keep set (pruned or terminally
 * closed duel records), plus anything under the prefix that does not match the exact ref format,
 * and bounds the survivors to the newest maxRefs so the namespace can never grow unbounded.
 */
export async function cleanupDuelSnapshotRefs(root: string, keepIds: ReadonlySet<string>, maxRefs = MAX_DUEL_SNAPSHOT_REFS): Promise<number> {
  const listed = await git(root, ["for-each-ref", "--format=%(refname)", "--sort=-creatordate", SNAPSHOT_REF_PREFIX.slice(0, -1)]);
  if (!listed.ok) {
    return 0;
  }
  let kept = 0;
  let deleted = 0;
  for (const ref of listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (!ref.startsWith(SNAPSHOT_REF_PREFIX)) {
      continue;
    }
    const duelId = ref.slice(SNAPSHOT_REF_PREFIX.length);
    if (DUEL_ID_PATTERN.test(duelId) && keepIds.has(duelId) && kept < Math.max(0, maxRefs)) {
      kept += 1;
      continue;
    }
    const removed = await git(root, ["update-ref", "-d", ref]);
    if (removed.ok) {
      deleted += 1;
    }
  }
  return deleted;
}

async function isBoundedRegularFile(absolutePath: string): Promise<boolean> {
  try {
    const stats = await lstat(absolutePath);
    return stats.isFile() && stats.size <= MAX_SNAPSHOT_FILE_BYTES;
  } catch {
    return false;
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = hardenedGitEnvironment()): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync("git", hardenedGitArguments(cwd, args), {
      timeout: 30_000,
      maxBuffer: 8_000_000,
      env
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
