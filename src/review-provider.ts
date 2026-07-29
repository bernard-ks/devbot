import { spawn } from "node:child_process";
import {
  hardenedGitArguments,
  publicErrorMessage,
  redactSensitiveText,
  sanitizeDiscordOutput,
  scopedChildEnvironment
} from "./security.js";
import { inspectTaskWorktree, type InspectTaskWorktreeResult, type TaskWorktree } from "./task-worktree.js";
import type { TaskRecord, TaskReviewChecks, TaskReviewState, TaskReviewStatus } from "./task-store.js";
import type { ProjectEntry } from "./types.js";

const PROCESS_TIMEOUT_MS = 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_000_000;
const SAFE_REF = /^(?!-)(?!.*(?:\.\.|@\{|\/\/|[~^:?*\\\s]))[A-Za-z0-9._/-]+$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface ProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface RunProcessOptions {
  cwd: string;
  input?: string;
  environment?: NodeJS.ProcessEnv;
}

export type ReviewProviderProcessRunner = (
  bin: string,
  args: readonly string[],
  options: RunProcessOptions
) => Promise<ProcessResult>;

export interface PublishReviewInput {
  project: ProjectEntry;
  task: TaskRecord;
  worktree: TaskWorktree;
}

export interface SyncReviewInput {
  project: ProjectEntry;
  review: TaskReviewState;
}

export interface ReviewProvider {
  readonly id: TaskReviewState["provider"];
  publish(input: PublishReviewInput): Promise<TaskReviewState>;
  sync(input: SyncReviewInput): Promise<TaskReviewState>;
}

interface GitHubPullRequestJson {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  isDraft?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  baseRefName?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
  reviewDecision?: unknown;
  statusCheckRollup?: unknown;
  isCrossRepository?: unknown;
}

export class GitHubReviewProvider implements ReviewProvider {
  readonly id = "github" as const;

  constructor(
    private readonly runProcess: ReviewProviderProcessRunner = defaultRunProcess,
    private readonly inspectWorktree: (worktree: TaskWorktree, diffLimit?: number) => Promise<InspectTaskWorktreeResult> = inspectTaskWorktree
  ) {}

  async publish(input: PublishReviewInput): Promise<TaskReviewState> {
    const { project, task, worktree } = input;
    assertPublishableTask(task);
    const inspection = await this.inspectWorktree(worktree, 0);
    if (!inspection.available) throw new Error(inspection.message);
    if (inspection.changes.length > 0) {
      throw new Error("Publish is blocked because the isolated task worktree has uncommitted changes.");
    }
    if (inspection.headRevision !== task.commitSha) {
      throw new Error("Publish is blocked because the task's recorded commit is not the current isolated-branch tip.");
    }

    const repository = await this.resolveRepository(project, worktree.path);
    await this.ensureAuthenticated(worktree.path);
    const existing = await this.listPullRequests(repository, task.branchName!, worktree.path);
    if (existing.length > 0) {
      const selected = existing.find((pullRequest) => pullRequest.headRefOid === task.commitSha) ?? existing[0]!;
      if (selected.headRefOid !== task.commitSha) {
        throw new Error("A pull request already exists for this branch at a different commit. Sync the task state before publishing again.");
      }
      if (selected.isCrossRepository) {
        throw new Error("A pull request already exists for a fork branch with this name. Publish from a uniquely named isolated origin branch.");
      }
      if (selected.state === "CLOSED") {
        throw new Error("The pull request for this task branch is closed. Create a new isolated task branch instead of silently reusing it.");
      }
      return this.hydrateReview(repository, selected, worktree.path);
    }

    await this.fetchAndVerifyBase(worktree, task.baseBranch!, project.metadata.defaultBranch ?? "main");
    await this.pushExactBranch(worktree, task.branchName!);

    const title = reviewTitle(task);
    const body = reviewBody(task);
    const created = await this.runProcess("gh", [
      "pr", "create",
      "--repo", repository,
      "--base", project.metadata.defaultBranch ?? "main",
      "--head", task.branchName!,
      "--draft",
      "--title", title,
      "--body-file", "-"
    ], {
      cwd: worktree.path,
      input: body,
      environment: githubEnvironment()
    });
    if (!created.ok) throw commandError("GitHub could not create the draft pull request", created);

    const createdUrl = created.stdout.trim().split(/\s+/).find((value) => value.startsWith("https://github.com/"));
    if (!createdUrl) {
      throw new Error("GitHub created the pull request but did not return a recognizable URL.");
    }
    const pullNumber = pullNumberFromUrl(createdUrl, repository);
    if (!pullNumber) throw new Error("GitHub returned a pull request URL that did not match the verified repository.");
    return this.viewReview(repository, pullNumber, worktree.path);
  }

  async sync(input: SyncReviewInput): Promise<TaskReviewState> {
    if (input.review.provider !== "github") throw new Error("This review provider cannot sync that task.");
    const configuredRepository = githubRepositoryFromRemote(input.project.metadata.repoUrl ?? "");
    if (configuredRepository && configuredRepository !== input.review.repository) {
      throw new Error("The configured repository no longer matches the task's published review.");
    }
    await this.ensureAuthenticated(input.project.root);
    return this.viewReview(input.review.repository, input.review.number, input.project.root);
  }

  private async resolveRepository(project: ProjectEntry, cwd: string): Promise<string> {
    const remote = await this.runProcess("git", hardenedGitArguments(cwd, ["remote", "get-url", "origin"]), {
      cwd,
      environment: gitPublishEnvironment()
    });
    if (!remote.ok) throw commandError("Publish requires an accessible origin remote", remote);
    const repository = githubRepositoryFromRemote(remote.stdout.trim());
    if (!repository) throw new Error("Publish currently requires origin to be a github.com repository.");
    const configured = project.metadata.repoUrl ? githubRepositoryFromRemote(project.metadata.repoUrl) : undefined;
    if (project.metadata.repoUrl && !configured) {
      throw new Error("The configured project repository URL is not a supported github.com URL.");
    }
    if (configured && configured !== repository) {
      throw new Error("The configured project repository does not match the isolated worktree's origin remote.");
    }
    return repository;
  }

  private async ensureAuthenticated(cwd: string): Promise<void> {
    const auth = await this.runProcess("gh", ["auth", "status", "--hostname", "github.com"], {
      cwd,
      environment: githubEnvironment()
    });
    if (!auth.ok) throw new Error("GitHub publishing requires an authenticated `gh` session on this machine.");
  }

  private async listPullRequests(repository: string, branch: string, cwd: string): Promise<GitHubPullRequest[]> {
    const result = await this.runProcess("gh", [
      "pr", "list",
      "--repo", repository,
      "--head", branch,
      "--state", "all",
      "--limit", "10",
      "--json", githubPullRequestFields()
    ], { cwd, environment: githubEnvironment() });
    if (!result.ok) throw commandError("GitHub could not inspect existing pull requests", result);
    const parsed = parseJson(result.stdout, "GitHub pull request list");
    if (!Array.isArray(parsed)) throw new Error("GitHub returned an invalid pull request list.");
    return parsed.map(parsePullRequest).filter((value): value is GitHubPullRequest => Boolean(value));
  }

  private async fetchAndVerifyBase(worktree: TaskWorktree, recordedBase: string, defaultBranch: string): Promise<void> {
    if (!validRef(defaultBranch)) throw new Error("The configured default branch is not a safe Git reference.");
    if (!/^[a-f0-9]{40}$/i.test(recordedBase)) throw new Error("The task is missing an exact recorded base revision.");
    const fetched = await this.runProcess("git", hardenedGitArguments(worktree.path, [
      "fetch", "--no-tags", "--no-write-fetch-head", "origin",
      `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`
    ]), { cwd: worktree.path, environment: gitPublishEnvironment() });
    if (!fetched.ok) throw commandError("Git could not refresh the remote default branch", fetched);

    const ancestry = await this.runProcess("git", hardenedGitArguments(worktree.path, [
      "merge-base", "--is-ancestor", `refs/remotes/origin/${defaultBranch}`, "HEAD"
    ]), { cwd: worktree.path, environment: gitPublishEnvironment() });
    if (!ancestry.ok) {
      throw new Error(`Publish is blocked because the task branch is stale against origin/${defaultBranch}. Run /task sync and validate again.`);
    }
  }

  private async pushExactBranch(worktree: TaskWorktree, branch: string): Promise<void> {
    if (!validRef(branch)) throw new Error("The isolated task branch is not a safe Git reference.");
    const pushed = await this.runProcess("git", hardenedGitArguments(worktree.path, [
      "push", "--porcelain", "--set-upstream", "--no-verify", "origin",
      `refs/heads/${branch}:refs/heads/${branch}`
    ]), { cwd: worktree.path, environment: gitPublishEnvironment() });
    if (!pushed.ok) throw commandError("Git could not push the exact isolated task branch", pushed);
  }

  private async viewReview(repository: string, number: number, cwd: string): Promise<TaskReviewState> {
    const result = await this.runProcess("gh", [
      "pr", "view", String(number),
      "--repo", repository,
      "--json", githubPullRequestFields()
    ], { cwd, environment: githubEnvironment() });
    if (!result.ok) throw commandError("GitHub could not refresh the pull request", result);
    const parsed = parsePullRequest(parseJson(result.stdout, "GitHub pull request"));
    if (!parsed) throw new Error("GitHub returned invalid pull request state.");
    return this.hydrateReview(repository, parsed, cwd);
  }

  private async hydrateReview(repository: string, pullRequest: GitHubPullRequest, cwd: string): Promise<TaskReviewState> {
    const unresolvedThreads = await this.unresolvedReviewThreads(repository, pullRequest.number, cwd);
    return {
      provider: "github",
      repository,
      number: pullRequest.number,
      url: pullRequest.url,
      branch: pullRequest.headRefName,
      baseBranch: pullRequest.baseRefName,
      commitSha: pullRequest.headRefOid,
      status: reviewStatus(pullRequest),
      draft: pullRequest.isDraft,
      checks: summarizeChecks(pullRequest.statusCheckRollup),
      unresolvedThreads,
      ...(pullRequest.mergeable ? { mergeable: pullRequest.mergeStateStatus || pullRequest.mergeable } : {}),
      ...(pullRequest.reviewDecision ? { reviewDecision: pullRequest.reviewDecision } : {}),
      lastSyncedAt: new Date().toISOString()
    };
  }

  private async unresolvedReviewThreads(repository: string, number: number, cwd: string): Promise<number> {
    const [owner, name] = repository.split("/");
    const query = [
      "query($owner:String!,$name:String!,$number:Int!){",
      "repository(owner:$owner,name:$name){",
      "pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}",
      "}}"
    ].join("");
    const result = await this.runProcess("gh", [
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${owner}`,
      "-F", `name=${name}`,
      "-F", `number=${number}`
    ], { cwd, environment: githubEnvironment() });
    if (!result.ok) return 0;
    const parsed = parseJson(result.stdout, "GitHub review threads") as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ isResolved?: unknown }> } } } };
    };
    const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes;
    return Array.isArray(nodes) ? nodes.filter((thread) => thread?.isResolved === false).length : 0;
  }
}

interface GitHubPullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  statusCheckRollup: unknown[];
  isCrossRepository: boolean;
}

function parsePullRequest(value: unknown): GitHubPullRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pullRequest = value as GitHubPullRequestJson;
  if (
    typeof pullRequest.number !== "number"
    || !Number.isSafeInteger(pullRequest.number)
    || pullRequest.number <= 0
    || typeof pullRequest.url !== "string"
    || !pullNumberFromUrl(pullRequest.url)
    || (pullRequest.state !== "OPEN" && pullRequest.state !== "CLOSED" && pullRequest.state !== "MERGED")
    || typeof pullRequest.isDraft !== "boolean"
    || typeof pullRequest.headRefName !== "string"
    || !validRef(pullRequest.headRefName)
    || typeof pullRequest.headRefOid !== "string"
    || !/^[a-f0-9]{40}$/i.test(pullRequest.headRefOid)
    || typeof pullRequest.baseRefName !== "string"
    || !validRef(pullRequest.baseRefName)
    || typeof pullRequest.isCrossRepository !== "boolean"
  ) {
    return undefined;
  }
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid.toLowerCase(),
    baseRefName: pullRequest.baseRefName,
    mergeable: typeof pullRequest.mergeable === "string" ? pullRequest.mergeable : "",
    mergeStateStatus: typeof pullRequest.mergeStateStatus === "string" ? pullRequest.mergeStateStatus : "",
    reviewDecision: typeof pullRequest.reviewDecision === "string" ? pullRequest.reviewDecision : "",
    statusCheckRollup: Array.isArray(pullRequest.statusCheckRollup) ? pullRequest.statusCheckRollup : [],
    isCrossRepository: pullRequest.isCrossRepository
  };
}

export function githubRepositoryFromRemote(value: string): string | undefined {
  const trimmed = value.trim();
  let candidate: string | undefined;
  const scp = /^git@github\.com:([^?#]+)$/i.exec(trimmed);
  if (scp?.[1]) {
    candidate = scp[1];
  } else {
    try {
      const url = new URL(trimmed);
      if (
        (url.protocol !== "https:" && url.protocol !== "ssh:")
        || url.hostname.toLowerCase() !== "github.com"
        || url.password
        || url.search
        || url.hash
      ) {
        return undefined;
      }
      candidate = url.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  }
  const repository = candidate.replace(/\.git$/i, "").replace(/\/+$/, "");
  const segments = repository.split("/");
  return SAFE_REPOSITORY.test(repository) && segments.every((segment) => segment !== "." && segment !== "..")
    ? repository
    : undefined;
}

function summarizeChecks(values: unknown[]): TaskReviewChecks {
  let pending = 0;
  let passed = 0;
  let failed = 0;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const check = value as { status?: unknown; conclusion?: unknown; state?: unknown };
    const status = typeof check.status === "string" ? check.status.toUpperCase() : "";
    const conclusion = typeof check.conclusion === "string"
      ? check.conclusion.toUpperCase()
      : typeof check.state === "string"
        ? check.state.toUpperCase()
        : "";
    if ((status && status !== "COMPLETED") || !conclusion || conclusion === "PENDING" || conclusion === "EXPECTED") {
      pending += 1;
    } else if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return { total: pending + passed + failed, pending, passed, failed };
}

function reviewStatus(pullRequest: GitHubPullRequest): TaskReviewStatus {
  if (pullRequest.state === "MERGED") return "merged";
  if (pullRequest.state === "CLOSED") return "closed";
  return pullRequest.isDraft ? "draft" : "open";
}

function reviewTitle(task: TaskRecord): string {
  return `Devbot task ${task.id}`;
}

function reviewBody(task: TaskRecord): string {
  const changedFiles = (task.changedFiles ?? []).slice(0, 50).map((file) => `- \`${safeMarkdown(file)}\``);
  const verification = (task.verification ?? []).slice(-12).map((item) => `- ${safeMarkdown(sanitizeDiscordOutput(item))}`);
  return [
    "## Summary",
    "",
    safeMarkdown(sanitizeDiscordOutput(task.text)),
    "",
    "## Devbot task",
    "",
    `- Task: \`${task.id}\``,
    `- Branch: \`${safeMarkdown(task.branchName ?? "unknown")}\``,
    `- Published commit: \`${task.commitSha}\``,
    "- Execution: isolated local task worktree",
    "",
    "## Changed paths",
    "",
    ...(changedFiles.length ? changedFiles : ["- No changed-path evidence recorded."]),
    "",
    "## Verification evidence",
    "",
    ...(verification.length ? verification : ["- No prior verification evidence recorded."]),
    "",
    "This draft was published through an explicit Devbot controller approval. Merge remains a separate human decision."
  ].join("\n");
}

function safeMarkdown(value: string): string {
  return value.replace(/```/g, "'''").replace(/@/g, "@\u200b").trim();
}

function githubPullRequestFields(): string {
  return [
    "number",
    "url",
    "state",
    "isDraft",
    "headRefName",
    "headRefOid",
    "baseRefName",
    "mergeable",
    "mergeStateStatus",
    "reviewDecision",
    "statusCheckRollup",
    "isCrossRepository"
  ].join(",");
}

function assertPublishableTask(task: TaskRecord): void {
  if (task.mode !== "action" || task.status !== "succeeded") {
    throw new Error("Only a succeeded change task can be published for review.");
  }
  if (!task.workspaceIsolated || !task.workspacePath || !task.branchName || !task.baseBranch || !task.commitSha) {
    throw new Error("Publish requires a committed, trusted isolated task worktree.");
  }
  if (task.branchMerged) throw new Error("This task branch is already merged.");
  if (!validRef(task.branchName)) throw new Error("The task branch is not a safe Git reference.");
  if (!/^[a-f0-9]{40}$/i.test(task.baseBranch) || !/^[a-f0-9]{40}$/i.test(task.commitSha)) {
    throw new Error("Publish requires exact recorded base and commit revisions.");
  }
}

function pullNumberFromUrl(value: string, repository?: string): number | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url.pathname);
    if (!match?.[1] || !match[2] || (repository && match[1] !== repository)) return undefined;
    const number = Number(match[2]);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
  } catch {
    return undefined;
  }
}

function validRef(value: string): boolean {
  return SAFE_REF.test(value) && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} was not valid JSON.`);
  }
}

function commandError(prefix: string, result: ProcessResult): Error {
  const detail = publicErrorMessage(result.stderr || result.stdout || `exit ${result.exitCode ?? "unknown"}`);
  return new Error(`${prefix}: ${detail}`);
}

function gitPublishEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...scopedChildEnvironment(environment, ["SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"]),
    GIT_EXTERNAL_DIFF: "",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function githubEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return scopedChildEnvironment(environment, [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_CONFIG_DIR",
    "GH_HOST"
  ]);
}

async function defaultRunProcess(
  bin: string,
  args: readonly string[],
  options: RunProcessOptions
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.environment ?? scopedChildEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes <= MAX_PROCESS_OUTPUT_BYTES) target.push(chunk);
      if (bytes > MAX_PROCESS_OUTPUT_BYTES) child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error) => finish({
      ok: false,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: redactSensitiveText(error.message),
      exitCode: null
    }));
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = bytes > MAX_PROCESS_OUTPUT_BYTES
        ? "Process output exceeded Devbot's limit."
        : Buffer.concat(stderr).toString("utf8");
      finish({ ok: code === 0 && bytes <= MAX_PROCESS_OUTPUT_BYTES, stdout: output, stderr: errors, exitCode: code });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: "Process timed out.",
        exitCode: null
      });
    }, PROCESS_TIMEOUT_MS);
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}
